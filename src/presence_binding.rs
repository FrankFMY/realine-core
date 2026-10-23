use crate::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PresenceAction {
    Prepare {
        grant: Grant,
        signal: PresenceSignal,
    },
    Commit {
        ticket: u32,
        grant: Grant,
    },
    Pending {
        grant: Grant,
    },
    View {},
    Revoke {},
    Dispose {},
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceInput {
    #[ts(type = "number")]
    pub now_ms: u64,
    pub action: PresenceAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct PresenceOutput {
    pub view: PresenceView,
    pub pending: Option<PreparedPresence>,
}

pub struct JsonPresence(pub Presence);

impl JsonPresence {
    pub fn new(scope: Scope, key: PresenceKey, config: PresenceConfig) -> Result<Self, ErrorCode> {
        Presence::new(scope, key, config).map(Self)
    }

    pub fn call(&mut self, input: &str) -> String {
        let result = crate::binding::decode::<PresenceInput>(input).and_then(|input| {
            match input.action {
                PresenceAction::Prepare { grant, signal } => {
                    self.0.prepare(grant, signal, input.now_ms)?;
                }
                PresenceAction::Commit { ticket, grant } => {
                    self.0.commit(ticket, grant, input.now_ms)?;
                }
                PresenceAction::Pending { grant } => {
                    self.0.revalidate_pending(&grant, input.now_ms)?;
                }
                PresenceAction::View {} => (),
                PresenceAction::Revoke {} => self.0.revoke(),
                PresenceAction::Dispose {} => self.0.dispose(),
            }
            Ok(PresenceOutput {
                view: self.0.view(),
                pending: self.0.pending(),
            })
        });
        crate::binding::encode(result)
    }
}
