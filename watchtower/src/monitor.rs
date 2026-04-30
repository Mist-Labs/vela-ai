use anyhow::Result;
use ethers::abi::Abi;
use ethers::prelude::*;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct Decision {
    pub id: U256,
    pub decision_hash: H256,
    pub evidence_cid: String,
    pub timestamp: U256,
    pub status: u8,
}

pub type WatchtowerClient = SignerMiddleware<Provider<Http>, LocalWallet>;
type DecisionTuple = ([u8; 32], String, String, U256, u8, [u8; 32]);

#[derive(Clone)]
pub struct VelaVaultContract {
    contract: Contract<WatchtowerClient>,
}

pub fn vault(address: Address, client: Arc<WatchtowerClient>) -> Result<VelaVaultContract> {
    let abi: Abi = serde_json::from_str(
        r#"[
            {"type":"function","name":"totalDecisions","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
            {"type":"function","name":"recentDecisions","stateMutability":"view","inputs":[{"name":"count","type":"uint256"}],"outputs":[{"name":"records","type":"tuple[]","components":[{"name":"decisionHash","type":"bytes32"},{"name":"explanation","type":"string"},{"name":"evidenceCID","type":"string"},{"name":"timestamp","type":"uint256"},{"name":"status","type":"uint8"},{"name":"attestationHash","type":"bytes32"}]}]},
            {"type":"function","name":"getDecision","stateMutability":"view","inputs":[{"name":"id","type":"uint256"}],"outputs":[{"type":"tuple","components":[{"name":"decisionHash","type":"bytes32"},{"name":"explanation","type":"string"},{"name":"evidenceCID","type":"string"},{"name":"timestamp","type":"uint256"},{"name":"status","type":"uint8"},{"name":"attestationHash","type":"bytes32"}]}]}
        ]"#,
    )?;
    Ok(VelaVaultContract {
        contract: Contract::new(address, abi, client),
    })
}

pub async fn fetch_pending_decisions(
    vault: &VelaVaultContract,
    scan_limit: u64,
) -> Result<Vec<Decision>> {
    let total: U256 = vault
        .contract
        .method::<_, U256>("totalDecisions", ())?
        .call()
        .await?;
    let mut cursor = total;
    let mut scanned = 0u64;
    let mut pending = Vec::new();

    while cursor > U256::zero() && scanned < scan_limit {
        cursor -= U256::one();
        scanned += 1;

        let record: DecisionTuple = vault
            .contract
            .method::<_, DecisionTuple>("getDecision", cursor)?
            .call()
            .await?;
        let (decision_hash, _, evidence_cid, timestamp, status, _) = record;
        if status == 0 {
            pending.push(Decision {
                id: cursor,
                decision_hash: H256::from(decision_hash),
                evidence_cid,
                timestamp,
                status,
            });
        }
    }

    Ok(pending)
}
