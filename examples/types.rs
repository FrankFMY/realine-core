use realine_core::*;
use ts_rs::{Config, TS};

fn main() {
    let cfg = Config::new();
    println!(
        "// Generated from the Rust protocol. Regenerate with the package build; do not edit.\n"
    );
    macro_rules! emit {
        ($($ty:ty),+ $(,)?) => { $(println!("export {}\n", <$ty>::decl(&cfg));)+ };
    }
    emit!(
        serde_json::Value,
        Scope,
        Grant,
        StreamConfig,
        StreamState,
        Cursor,
        SyncRequest,
        Snapshot,
        Event,
        Delivery,
        SyncReason,
        Receive,
        StreamView,
        ErrorCode,
        StreamAction,
        StreamInput,
        StreamResult,
        StreamOutput,
        BindingReply<()>,
        PresenceKey,
        PresenceConfig,
        PresenceSignal,
        PresenceState,
        PresenceLifecycle,
        PresenceView,
        PresenceEntry,
        PreparedPresence,
        PresenceAction,
        PresenceInput,
        PresenceOutput,
        SortDirection,
        MissingPosition,
        ListSort,
        ListQuery,
        PageCursor,
        ListRequest,
        ListConfig,
        ListRow,
        ListPage,
        DepartureReason,
        ListDeparture,
        ListPatch,
        ScrollAnchor,
        ListCustody,
        ListSlot,
        ListView,
        ListAction,
        ListInput,
        ListOutput,
        ListPlanAction,
        ListPlanOutput,
        CursorAdvance
    );
}
