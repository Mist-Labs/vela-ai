use anyhow::{Context, Result};
use serde_json::json;

#[derive(Clone, Debug)]
pub struct Notifier {
    client: reqwest::Client,
    api_key: Option<String>,
    fid: Option<u64>,
    endpoint: String,
}

impl Notifier {
    pub fn from_env() -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key: std::env::var("WARPCAST_API_KEY").ok(),
            fid: std::env::var("FARCASTER_FID")
                .ok()
                .and_then(|v| v.parse().ok()),
            endpoint: std::env::var("WARPCAST_DM_URL")
                .unwrap_or_else(|_| "https://api.warpcast.com/v2/ext-send-direct-cast".to_string()),
        }
    }

    pub async fn alert(&self, message: &str) -> Result<()> {
        let (Some(api_key), Some(fid)) = (&self.api_key, self.fid) else {
            tracing::warn!(target: "watchtower", "{message}");
            return Ok(());
        };

        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(api_key)
            .json(&json!({
                "recipientFid": fid,
                "message": message,
            }))
            .send()
            .await
            .context("failed to send Farcaster alert")?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(target: "watchtower", status = %status, body = %body, "Farcaster alert failed");
        }

        Ok(())
    }
}
