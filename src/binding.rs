use crate::*;

pub struct JsonStream(pub Stream);

impl JsonStream {
    pub fn new(scope: Scope, config: StreamConfig) -> Result<Self, ErrorCode> {
        Stream::new(scope, config).map(Self)
    }

    pub fn call(&mut self, input: &str) -> String {
        let result = decode::<StreamInput>(input).and_then(|input| {
            let now = input.now_ms;
            let result = match input.action {
                StreamAction::Open { grant } => StreamResult::Sync {
                    request: self.0.open(grant, now)?,
                },
                StreamAction::Snapshot { snapshot } => StreamResult::Receive {
                    received: self.0.snapshot(snapshot, now)?,
                },
                StreamAction::Event { event } => StreamResult::Receive {
                    received: self.0.event(event, now)?,
                },
                StreamAction::Take { limit } => StreamResult::Deliveries {
                    items: self.0.take(limit, now)?,
                },
                StreamAction::Tick {} => {
                    self.0.tick(now)?;
                    StreamResult::None
                }
                StreamAction::View {} => StreamResult::None,
                StreamAction::Disconnect {} => {
                    self.0.disconnect();
                    StreamResult::None
                }
                StreamAction::Revoke {} => {
                    self.0.revoke();
                    StreamResult::None
                }
                StreamAction::Dispose {} => {
                    self.0.dispose();
                    StreamResult::None
                }
            };
            Ok(StreamOutput {
                view: self.0.view(),
                result,
            })
        });
        encode(result)
    }
}

pub(crate) fn decode<T: serde::de::DeserializeOwned>(input: &str) -> Result<T, ErrorCode> {
    if input.len() > 1_056_768 {
        return Err(ErrorCode::InvalidFrame);
    }
    serde_json::from_str(input).map_err(|_| ErrorCode::InvalidFrame)
}

pub(crate) fn encode<T: serde::Serialize>(result: Result<T, ErrorCode>) -> String {
    let reply = match result {
        Ok(value) => BindingReply::Ok { value },
        Err(code) => BindingReply::Error { code },
    };
    serde_json::to_string(&reply).expect("bounded core types are JSON serializable")
}
