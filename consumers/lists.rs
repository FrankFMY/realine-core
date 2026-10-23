use realine_core::*;
use serde_json::{Value, json};

pub fn run(fixture: Value) -> Value {
    let request: ListRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
    let config: ListConfig = serde_json::from_value(fixture["config"].clone()).unwrap();
    let plan = ListPlan::new(request.clone(), config).unwrap();
    let mut core = JsonList::new(request, config).unwrap();
    let trace: Vec<Value> = fixture["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| {
            let mut step = step.clone();
            for kind in ["snapshot", "event"] {
                if let Some(data) = step
                    .get_mut("action")
                    .and_then(|a| a.get_mut("action"))
                    .and_then(|a| a.get_mut(kind))
                    .and_then(|a| a.get_mut("data"))
                {
                    data["request_key"] = json!(plan.key());
                }
            }
            serde_json::from_str(&core.call(&step.to_string())).unwrap()
        })
        .collect();
    assert_eq!(
        trace[3]["value"]["view"]["slots"][0]["departure"],
        "deleted"
    );
    assert_eq!(trace[3]["value"]["view"]["slots"][1]["conflict"], true);
    assert_eq!(trace[6]["code"], "busy");
    assert_eq!(trace[12]["value"]["result"]["received"]["reason"], "gap");
    assert_eq!(trace[16]["code"], "denied");
    assert_eq!(trace[19]["value"]["view"]["stream"]["state"], "disposed");
    json!(trace)
}
