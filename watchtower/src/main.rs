mod checker;
mod monitor;
mod notifier;
mod pauser;

use anyhow::{Context, Result};
use checker::{verify_evidence, EvidenceFetcher};
use ethers::prelude::*;
use monitor::{fetch_pending_decisions, vault, WatchtowerClient};
use notifier::Notifier;
use pauser::Pauser;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};

#[derive(Clone, Debug)]
struct Config {
    rpc_url: String,
    private_key: String,
    vault: Address,
    attestation: Address,
    registered_enclave: Address,
    poll_interval: Duration,
    attestation_timeout: Duration,
    scan_limit: u64,
}

impl Config {
    fn from_env() -> Result<Self> {
        Ok(Self {
            rpc_url: env("RPC_URL")?,
            private_key: env("WATCHTOWER_PRIVATE_KEY").or_else(|_| env("PRIVATE_KEY"))?,
            vault: env_address("VELA_VAULT_ADDRESS").or_else(|_| env_address("VAULT_ADDRESS"))?,
            attestation: env_address("ATTESTATION_CONTRACT_ADDRESS")?,
            registered_enclave: env_address("REGISTERED_ENCLAVE_KEY")?,
            poll_interval: Duration::from_secs(env_u64("POLL_INTERVAL_SECONDS", 30)?),
            attestation_timeout: Duration::from_secs(env_u64("ATTESTATION_TIMEOUT_SECONDS", 90)?),
            scan_limit: env_u64("WATCHTOWER_SCAN_LIMIT", 250)?,
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let config = Config::from_env()?;
    let provider = Provider::<Http>::try_from(config.rpc_url.as_str())?;
    let chain_id = provider.get_chainid().await?.as_u64();
    let wallet = config
        .private_key
        .parse::<LocalWallet>()
        .context("WATCHTOWER_PRIVATE_KEY is invalid")?
        .with_chain_id(chain_id);
    let client: Arc<WatchtowerClient> = Arc::new(SignerMiddleware::new(provider, wallet));

    let vault_contract = vault(config.vault, client.clone())?;
    let pauser = Pauser::new(config.attestation, config.vault, client);
    let fetcher = EvidenceFetcher::from_env();
    let notifier = Notifier::from_env();
    let mut reported = HashSet::<U256>::new();

    info!(
        vault = ?config.vault,
        attestation = ?config.attestation,
        enclave = ?config.registered_enclave,
        "Vela watchtower started"
    );

    loop {
        if let Err(err) = tick(
            &config,
            &vault_contract,
            &pauser,
            &fetcher,
            &notifier,
            &mut reported,
        )
        .await
        {
            error!(error = %err, "watchtower tick failed");
        }
        tokio::time::sleep(config.poll_interval).await;
    }
}

async fn tick(
    config: &Config,
    vault_contract: &monitor::VelaVaultContract,
    pauser: &Pauser,
    fetcher: &EvidenceFetcher,
    notifier: &Notifier,
    reported: &mut HashSet<U256>,
) -> Result<()> {
    let decisions = fetch_pending_decisions(vault_contract, config.scan_limit).await?;
    for decision in decisions {
        if decision.status == 1 || pauser.is_settled(decision.id).await? {
            continue;
        }
        if reported.contains(&decision.id) {
            continue;
        }

        let age = now_secs().saturating_sub(decision.timestamp.as_u64());
        match fetcher.fetch_raw(&decision.evidence_cid).await {
            Ok(raw) => {
                match verify_evidence(&raw, decision.decision_hash, config.registered_enclave) {
                    Ok(outcome) => {
                        match pauser
                            .verify_and_settle(
                                decision.id,
                                outcome.content_hash,
                                &outcome.signature,
                            )
                            .await
                        {
                            Ok(tx_hash) => {
                                info!(
                                    decision = %decision.id,
                                    signer = ?outcome.signer,
                                    content_hash = ?outcome.content_hash,
                                    tx = ?tx_hash,
                                    "decision evidence verified and settled"
                                );
                            }
                            Err(err) if age < config.attestation_timeout.as_secs() => {
                                warn!(decision = %decision.id, error = %err, "settlement failed inside timeout");
                            }
                            Err(err) => {
                                report_failure(
                                    pauser,
                                    notifier,
                                    reported,
                                    decision.id,
                                    &format!("valid evidence failed on-chain settlement: {err}"),
                                )
                                .await?;
                            }
                        }
                    }
                    Err(err) if age < config.attestation_timeout.as_secs() => {
                        warn!(decision = %decision.id, error = %err, "attestation pending inside timeout");
                    }
                    Err(err) => {
                        report_failure(
                            pauser,
                            notifier,
                            reported,
                            decision.id,
                            &format!("TEE verification failed: {err}"),
                        )
                        .await?;
                    }
                }
            }
            Err(err) if age < config.attestation_timeout.as_secs() => {
                warn!(decision = %decision.id, error = %err, "evidence unavailable inside timeout");
            }
            Err(err) => {
                report_failure(
                    pauser,
                    notifier,
                    reported,
                    decision.id,
                    &format!("0G evidence unavailable: {err}"),
                )
                .await?;
            }
        }
    }

    Ok(())
}

async fn report_failure(
    pauser: &Pauser,
    notifier: &Notifier,
    reported: &mut HashSet<U256>,
    decision_id: U256,
    reason: &str,
) -> Result<()> {
    let tx_hash = pauser.report_failure(decision_id, reason).await?;
    reported.insert(decision_id);
    let message = format!(
        "[Vela] ALERT: {reason} for decision #{decision_id}. Vault auto-pause tx: {tx_hash:?}"
    );
    notifier.alert(&message).await?;
    error!("{message}");
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("{name} is required"))
}

fn env_address(name: &str) -> Result<Address> {
    env(name)?
        .parse()
        .with_context(|| format!("{name} must be an address"))
}

fn env_u64(name: &str, default: u64) -> Result<u64> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => value
            .parse()
            .with_context(|| format!("{name} must be a u64")),
        _ => Ok(default),
    }
}
