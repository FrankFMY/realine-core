use crate::*;

pub struct JsonList(pub ListWindow);
impl JsonList {
    pub fn new(request: ListRequest, config: ListConfig) -> Result<Self, ErrorCode> {
        ListWindow::new(request, config).map(Self)
    }
    pub fn call(&mut self, input: &str) -> String {
        let result = binding::decode::<ListInput>(input).and_then(|input| {
            let now = input.now_ms;
            let result = match input.action {
                ListAction::Stream { action } => match action {
                    StreamAction::Open { grant } => StreamResult::Sync {
                        request: self.0.open(grant, now)?,
                    },
                    StreamAction::Snapshot { snapshot } => StreamResult::Receive {
                        received: self.0.snapshot(snapshot, now)?,
                    },
                    StreamAction::Event { event } => StreamResult::Receive {
                        received: self.0.event(event, now)?,
                    },
                    StreamAction::Take { .. } => {
                        self.0.tick(now)?;
                        StreamResult::Deliveries { items: vec![] }
                    }
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
                },
                ListAction::Custody { custody } => {
                    self.0.tick(now)?;
                    self.0.set_custody(custody)?;
                    StreamResult::None
                }
                ListAction::Accept {} => {
                    self.0.tick(now)?;
                    self.0.accept_changes()?;
                    StreamResult::None
                }
                ListAction::View {} => StreamResult::None,
            };
            Ok(ListOutput {
                view: self.0.view(),
                result,
            })
        });
        binding::encode(result)
    }
}

pub struct JsonListPlan(pub ListPlan);
impl JsonListPlan {
    pub fn new(request: ListRequest, config: ListConfig) -> Result<Self, ErrorCode> {
        ListPlan::new(request, config).map(Self)
    }
    pub fn call(&self, input: &str) -> String {
        binding::encode(binding::decode::<ListPlanAction>(input).and_then(|action| {
            match action {
                ListPlanAction::Advance { before, after } => self
                    .0
                    .advance(&before, &after)
                    .map(|advance| ListPlanOutput::Advance { advance }),
                ListPlanAction::Page {
                    cursor,
                    rows,
                    has_more,
                } => self
                    .0
                    .page(&cursor, rows, has_more)
                    .map(|page| ListPlanOutput::Page { page }),
                ListPlanAction::Diff {
                    cursor,
                    before,
                    after,
                    departures,
                } => self
                    .0
                    .diff(&cursor, &before, &after, departures)
                    .map(|patch| ListPlanOutput::Patch { patch }),
            }
        }))
    }
}
