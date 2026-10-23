use crate::ErrorCode;
use serde_json::Value;

/// Incoming native Values are caller-allocated and may be deeper than serde's JSON decoder admits.
/// Own them before any fallible check so rejection, including denial, cannot recursively drop them.
pub(crate) struct Payload(Value);

impl Payload {
    pub fn new(value: Value) -> Self {
        Self(value)
    }
    pub fn into_inner(mut self) -> Value {
        std::mem::take(&mut self.0)
    }

    pub fn size(&self, limit: u32) -> Result<u32, ErrorCode> {
        Self::measure(&self.0, limit)
    }
    pub(crate) fn measure(value: &Value, limit: u32) -> Result<u32, ErrorCode> {
        fn inspect(value: &Value, depth: u32, remaining: &mut u32) -> Result<(), ErrorCode> {
            if depth > 32 || *remaining == 0 {
                return Err(ErrorCode::PayloadTooLarge);
            }
            *remaining -= 1;
            match value {
                Value::Array(items) => {
                    for value in items {
                        inspect(value, depth + 1, remaining)?;
                    }
                }
                Value::Object(items) => {
                    for value in items.values() {
                        inspect(value, depth + 1, remaining)?;
                    }
                }
                _ => (),
            }
            Ok(())
        }
        let mut remaining = limit;
        inspect(value, 0, &mut remaining)?;
        struct Counter {
            count: u32,
            limit: u32,
        }
        impl std::io::Write for Counter {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                let size = u32::try_from(bytes.len())
                    .ok()
                    .and_then(|n| self.count.checked_add(n));
                if size.is_none_or(|n| n > self.limit) {
                    return Err(std::io::ErrorKind::FileTooLarge.into());
                }
                self.count = size.unwrap();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut counter = Counter { count: 0, limit };
        serde_json::to_writer(&mut counter, value).map_err(|_| ErrorCode::PayloadTooLarge)?;
        Ok(counter.count)
    }
}

impl Drop for Payload {
    fn drop(&mut self) {
        let mut pending = vec![std::mem::take(&mut self.0)];
        while let Some(value) = pending.pop() {
            match value {
                Value::Array(children) => pending.extend(children),
                Value::Object(children) => pending.extend(children.into_values()),
                _ => (),
            }
        }
    }
}
