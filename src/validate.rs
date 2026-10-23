use crate::{ErrorCode, Grant, Scope};

pub(crate) const MAX_TIME: u64 = 9_007_199_254_740_991;

pub(crate) fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

pub(crate) fn scope(scope: &Scope) -> Result<(), ErrorCode> {
    if [
        &scope.product,
        &scope.tenant,
        &scope.resource,
        &scope.channel,
    ]
    .iter()
    .all(|part| identifier(part))
    {
        Ok(())
    } else {
        Err(ErrorCode::InvalidScope)
    }
}

pub(crate) fn grant(grant: &Grant, expected: &Scope, now_ms: u64) -> Result<(), ErrorCode> {
    scope(&grant.scope)?;
    if &grant.scope != expected {
        return Err(ErrorCode::Denied);
    }
    if ![
        &grant.actor_id,
        &grant.session_id,
        &grant.permission_version,
    ]
    .iter()
    .all(|id| identifier(id))
        || grant.expires_at_ms > MAX_TIME
    {
        return Err(ErrorCode::InvalidGrant);
    }
    if grant.expires_at_ms <= now_ms {
        return Err(ErrorCode::Expired);
    }
    Ok(())
}

pub(crate) fn time(now_ms: u64, previous_ms: u64) -> Result<(), ErrorCode> {
    if now_ms > MAX_TIME || now_ms < previous_ms {
        Err(ErrorCode::InvalidTime)
    } else {
        Ok(())
    }
}
