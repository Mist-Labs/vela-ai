use anyhow::Result;
use ethers::prelude::*;
use std::sync::Arc;

use crate::monitor::WatchtowerClient;

abigen!(
    AttestationContract,
    r#"[
        function isSettled(address vault,uint256 decisionId) view returns (bool)
        function verifyAndSettle(address vault,uint256 decisionId,bytes32 contentHash,bytes sig)
        function reportFailure(address vault,uint256 decisionId,string reason)
    ]"#
);

pub struct Pauser {
    contract: AttestationContract<WatchtowerClient>,
    vault: Address,
}

impl Pauser {
    pub fn new(attestation: Address, vault: Address, client: Arc<WatchtowerClient>) -> Self {
        Self {
            contract: AttestationContract::new(attestation, client),
            vault,
        }
    }

    pub async fn is_settled(&self, decision_id: U256) -> Result<bool> {
        Ok(self
            .contract
            .is_settled(self.vault, decision_id)
            .call()
            .await?)
    }

    pub async fn report_failure(&self, decision_id: U256, reason: &str) -> Result<TxHash> {
        let call = self
            .contract
            .report_failure(self.vault, decision_id, reason.to_string());
        let pending = call.send().await?;
        Ok(pending.tx_hash())
    }

    pub async fn verify_and_settle(
        &self,
        decision_id: U256,
        content_hash: H256,
        signature: &str,
    ) -> Result<TxHash> {
        let sig = decode_hex_bytes(signature)?;
        let call =
            self.contract
                .verify_and_settle(self.vault, decision_id, content_hash.into(), sig);
        let pending = call.send().await?;
        Ok(pending.tx_hash())
    }
}

fn decode_hex_bytes(value: &str) -> Result<Bytes> {
    let trimmed = value.strip_prefix("0x").unwrap_or(value);
    Ok(Bytes::from(hex::decode(trimmed)?))
}
