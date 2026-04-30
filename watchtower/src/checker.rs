use anyhow::{anyhow, bail, Context, Result};
use ethers::types::{Address, RecoveryMessage, Signature, H256};
use ethers::utils::hash_message;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct DecisionEvidence {
    pub signed_payload: String,
    pub tee_attestation: Option<TeeAttestation>,
}

#[derive(Debug, Deserialize)]
pub struct TeeAttestation {
    pub signature: String,
}

#[derive(Clone, Debug)]
pub struct EvidenceFetcher {
    client: reqwest::Client,
    url_template: Option<String>,
    local_dir: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct VerificationOutcome {
    pub content_hash: H256,
    pub signer: Address,
    pub signature: String,
}

impl EvidenceFetcher {
    pub fn from_env() -> Self {
        Self {
            client: reqwest::Client::new(),
            url_template: std::env::var("ZERO_G_FETCH_URL_TEMPLATE").ok(),
            local_dir: std::env::var("WATCHTOWER_RECORD_DIR")
                .ok()
                .map(PathBuf::from),
        }
    }

    pub async fn fetch_raw(&self, cid: &str) -> Result<Vec<u8>> {
        if cid.starts_with("http://") || cid.starts_with("https://") {
            return self.fetch_url(cid).await;
        }

        if let Some(dir) = &self.local_dir {
            let safe_name = cid.replace('/', "_");
            let path = dir.join(format!("{safe_name}.json"));
            return tokio::fs::read(&path)
                .await
                .with_context(|| format!("failed to read local evidence file {}", path.display()));
        }

        if let Some(template) = &self.url_template {
            let url = template.replace("{cid}", cid);
            return self.fetch_url(&url).await;
        }

        bail!(
            "no evidence fetcher configured; set ZERO_G_FETCH_URL_TEMPLATE, WATCHTOWER_RECORD_DIR, or use an HTTP evidence CID"
        );
    }

    async fn fetch_url(&self, url: &str) -> Result<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .with_context(|| format!("failed to fetch evidence from {url}"))?;
        let status = response.status();
        if !status.is_success() {
            bail!("evidence fetch failed with HTTP {status} for {url}");
        }
        Ok(response.bytes().await?.to_vec())
    }
}

pub fn verify_evidence(
    raw: &[u8],
    committed_hash: H256,
    registered_enclave: Address,
) -> Result<VerificationOutcome> {
    let evidence: DecisionEvidence =
        serde_json::from_slice(raw).context("decision evidence is not valid JSON")?;
    let content_hash = hash_message(&evidence.signed_payload);
    if content_hash != committed_hash {
        bail!("content hash mismatch: committed {committed_hash:?}, fetched {content_hash:?}");
    }

    let attestation = evidence
        .tee_attestation
        .ok_or_else(|| anyhow!("TEE attestation missing"))?;
    let signature: Signature = attestation
        .signature
        .parse()
        .context("TEE attestation signature is not a 65-byte hex ECDSA signature")?;
    let signer = signature
        .recover(RecoveryMessage::Hash(content_hash))
        .context("failed to recover enclave signer from TEE signature")?;
    if signer != registered_enclave {
        bail!("unregistered enclave signer: recovered {signer:?}, expected {registered_enclave:?}");
    }

    Ok(VerificationOutcome {
        content_hash,
        signer,
        signature: attestation.signature,
    })
}

#[cfg(test)]
fn evidence_json(signed_payload: &str, signature: &Signature) -> String {
    serde_json::json!({
        "signed_payload": signed_payload,
        "tee_attestation": { "signature": signature.to_string() }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ethers::signers::{LocalWallet, Signer};

    #[test]
    fn recovers_raw_hash_signature() {
        let wallet: LocalWallet =
            "0x59c6995e998f97a5a0044966f094538c5c45dae6d8ae152d75d3988b1fc45e59"
                .parse()
                .unwrap();
        let raw = r#"{"action":"hold","value_usdc":0,"pool":"","reason":"No trade"}"#;
        let hash = hash_message(raw);
        let sig = wallet.sign_hash(hash).unwrap();

        let recovered = sig.recover(RecoveryMessage::Hash(hash)).unwrap();
        assert_eq!(recovered, wallet.address());
    }

    #[test]
    fn verifies_signed_payload_evidence() {
        let wallet: LocalWallet =
            "0x59c6995e998f97a5a0044966f094538c5c45dae6d8ae152d75d3988b1fc45e59"
                .parse()
                .unwrap();
        let signed_payload = r#"{"action":"hold","value_usdc":0,"pool":"","reason":"No trade"}"#;
        let hash = hash_message(signed_payload);
        let sig = wallet.sign_hash(hash).unwrap();
        let raw = evidence_json(signed_payload, &sig);

        let outcome = verify_evidence(raw.as_bytes(), hash, wallet.address()).unwrap();

        assert_eq!(outcome.signer, wallet.address());
        assert_eq!(outcome.content_hash, hash);
        assert_eq!(outcome.signature, sig.to_string());
    }

    #[test]
    fn rejects_missing_attestation() {
        let raw = br#"{"signed_payload":"{\"action\":\"hold\"}"}"#;
        let hash = hash_message(r#"{"action":"hold"}"#);
        let err = verify_evidence(raw, hash, Address::zero()).unwrap_err();
        assert!(err.to_string().contains("TEE attestation missing"));
    }
}
