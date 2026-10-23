use crate::*;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmList(JsonList);
#[wasm_bindgen]
impl WasmList {
    #[wasm_bindgen(constructor)]
    pub fn new(request: &str, config: &str) -> Result<WasmList, JsValue> {
        let create =
            || JsonList::new(binding::decode(request)?, binding::decode(config)?).map(Self);
        create().map_err(|code| JsValue::from_str(&binding::encode::<()>(Err(code))))
    }
    pub fn call(&mut self, input: &str) -> String {
        self.0.call(input)
    }
}

#[wasm_bindgen]
pub struct WasmListPlan(JsonListPlan);
#[wasm_bindgen]
impl WasmListPlan {
    #[wasm_bindgen(constructor)]
    pub fn new(request: &str, config: &str) -> Result<WasmListPlan, JsValue> {
        let create =
            || JsonListPlan::new(binding::decode(request)?, binding::decode(config)?).map(Self);
        create().map_err(|code| JsValue::from_str(&binding::encode::<()>(Err(code))))
    }
    pub fn key(&self) -> String {
        self.0.0.key().into()
    }
    pub fn query_key(&self) -> String {
        self.0.0.query_key().into()
    }
    pub fn call(&self, input: &str) -> String {
        self.0.call(input)
    }
}

#[wasm_bindgen]
pub struct WasmPresence(JsonPresence);

#[wasm_bindgen]
impl WasmPresence {
    #[wasm_bindgen(constructor)]
    pub fn new(scope: &str, key: &str, config: &str) -> Result<WasmPresence, JsValue> {
        let create = || {
            JsonPresence::new(
                binding::decode(scope)?,
                binding::decode(key)?,
                binding::decode(config)?,
            )
            .map(Self)
        };
        create().map_err(|code| JsValue::from_str(&binding::encode::<()>(Err(code))))
    }

    pub fn call(&mut self, input: &str) -> String {
        self.0.call(input)
    }
}

#[wasm_bindgen]
pub struct WasmStream(JsonStream);

#[wasm_bindgen]
impl WasmStream {
    #[wasm_bindgen(constructor)]
    pub fn new(scope: &str, config: &str) -> Result<WasmStream, JsValue> {
        let create =
            || JsonStream::new(binding::decode(scope)?, binding::decode(config)?).map(Self);
        create().map_err(|code| JsValue::from_str(&binding::encode::<()>(Err(code))))
    }

    pub fn call(&mut self, input: &str) -> String {
        self.0.call(input)
    }
}
