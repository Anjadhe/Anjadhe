import XCTest
@testable import AnjadheCore

/// The phone's own AI (docs/MOBILE_NATIVE.md "M5", laws P1-P5 in PhoneAI.swift).
final class PhoneAITests: XCTestCase {

    private func j(_ s: String) -> JSONValue { try! JSONValue.parse(s) }

    // P1: absent, null, or a non-cloud engine all mean OFF.
    func testChoiceOffUnlessNenvaCloud() {
        XCTAssertNil(PhoneModelChoice.from([:]))
        XCTAssertNil(PhoneModelChoice.from(["fallback": .null]))
        // P1 (2026-10-02): no choice follows a Mac on nenva cloud; Off wins.
        let cloudMac = j(#"{"engine":"anjadhe","model":"anjadhe-cloud","name":"nenva cloud lite"}"#)
        XCTAssertEqual(PhoneModelChoice.resolve([:], macBrain: cloudMac)?.model, "nenva-cloud-lite")
        XCTAssertEqual(PhoneModelChoice.resolve(["updatedAt": .string("x")], macBrain: cloudMac)?.displayName, "nenva cloud lite")
        XCTAssertNil(PhoneModelChoice.resolve(["fallback": .null], macBrain: cloudMac), "an explicit Off wins")
        XCTAssertNil(PhoneModelChoice.resolve([:], macBrain: j(#"{"engine":"local"}"#)), "a local Mac: the phone waits")
        XCTAssertNil(PhoneModelChoice.resolve([:], macBrain: nil))
        XCTAssertEqual(PhoneModelChoice.resolve(j(#"{"fallback":{"engine":"anjadhe","model":"nenva-cloud-pro"}}"#).objectValue!, macBrain: cloudMac)?.model,
                       "nenva-cloud-pro", "a choice of its own wins")
        XCTAssertNil(PhoneModelChoice.from(j(#"{"fallback":{"engine":"openai","model":"gpt"}}"#).objectValue!))
        let c = PhoneModelChoice.from(j(#"{"fallback":{"engine":"anjadhe","model":"nenva-cloud-pro","label":"nenva cloud pro"}}"#).objectValue!)
        XCTAssertEqual(c?.model, "nenva-cloud-pro")
        XCTAssertEqual(c?.displayName, "nenva cloud pro")
        // Round-trips through the blob the Mac also writes.
        XCTAssertEqual(PhoneModelChoice.from(c!.blob(now: "2026-09-25T00:00:00Z")), c)
    }

    // Model tiers (2026-09-30): a curated model is named by tier, never by
    // model; an old choice reads as its tier; an unknown id never shows its label.
    func testModelTiers() {
        let old = PhoneModelChoice.from(j(#"{"fallback":{"engine":"anjadhe","model":"anjadhe-cloud-qwen3.8","label":"Qwen3.8-2.4T-A95B"}}"#).objectValue!)
        XCTAssertEqual(old?.model, "nenva-cloud-pro")
        XCTAssertEqual(old?.displayName, "nenva cloud pro")
        XCTAssertEqual(PhoneModelChoice(engine: "anjadhe", model: "anjadhe-cloud", label: "nenva Cloud").displayName, "nenva cloud lite")
        XCTAssertEqual(PhoneModelChoice(engine: "anjadhe", model: "anjadhe-cloud-max", label: "DeepSeek-V4").displayName, "nenva cloud")
        XCTAssertEqual(ModelTiers.legacyId("nenva-cloud-lite"), "anjadhe-cloud")
        XCTAssertEqual(ModelTiers.legacyId("nenva-cloud-pro"), "anjadhe-cloud-qwen3.8")
        XCTAssertEqual(ModelTiers.displayForStored("anjadhe-cloud"), "nenva cloud lite")
        XCTAssertEqual(ModelTiers.displayForStored("nenva Cloud"), "nenva cloud")
        XCTAssertEqual(ModelTiers.displayForStored("/m/Qwen3.6-27B.gguf"), "nenva local")
        XCTAssertEqual(ModelTiers.displayForStored("gpt-5"), "gpt-5")
    }

    // P3: messages and spending are off unless turned on; notes on unless off.
    func testPrivacyClasses() {
        XCTAssertTrue(PhonePrivacy.allows("notes", settings: [:]))
        XCTAssertFalse(PhonePrivacy.allows("messages", settings: [:]))
        XCTAssertFalse(PhonePrivacy.allows("spending", settings: [:]))
        let s = j(#"{"classes":{"messages":true,"notes":false}}"#).objectValue!
        XCTAssertTrue(PhonePrivacy.allows("messages", settings: s))
        XCTAssertFalse(PhonePrivacy.allows("notes", settings: s))
    }

    func testSSETextAndDone() {
        var acc = SSEAccumulator()
        XCTAssertEqual(acc.feed(#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#), "Hel")
        XCTAssertEqual(acc.feed(": keep-alive"), "")
        XCTAssertEqual(acc.feed(#"data: {"choices":[{"delta":{"content":"lo"}}]}"#), "lo")
        acc.feed("data: [DONE]")
        XCTAssertEqual(acc.content, "Hello")
        XCTAssertTrue(acc.done)
        XCTAssertTrue(acc.toolCalls.isEmpty)
    }

    // Tool calls arrive as fragments by index; arguments concatenate.
    func testSSEToolCallFragments() {
        var acc = SSEAccumulator()
        acc.feed(#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"web_search","arguments":"{\"que"}}]}}]}"#)
        acc.feed(#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ry\":\"visa\"}"}}]}}]}"#)
        acc.feed(#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"list_tasks","arguments":"{}"}}]}}]}"#)
        XCTAssertEqual(acc.toolCalls, [
            StreamedToolCall(id: "call_a", name: "web_search", arguments: #"{"query":"visa"}"#),
            StreamedToolCall(id: "call_b", name: "list_tasks", arguments: "{}"),
        ])
    }

    func testLeakedToolCallsStripped() {
        let raw = "<tool_call>\n<function=read_url>\n<parameter=url>\nhttps://x\n</parameter>\n</function>\n</tool_call>"
        XCTAssertEqual(LeakedToolCalls.strip(raw), "")
        XCTAssertEqual(LeakedToolCalls.strip("Answer.\n<function=web_search>"), "Answer.")
        XCTAssertEqual(LeakedToolCalls.strip("The function returns a list."), "The function returns a list.")
    }

    // P2 + P5: a phone answer in the shared conversation is signed.
    func testSignedTurnsInTheSharedConversation() {
        let conv = j(#"""
        {"id":"conv_1","channel":"mobile","messages":[
          {"role":"user","content":"What is on today?"},
          {"role":"assistant","content":"Two tasks."},
          {"role":"user","content":"And tomorrow?"},
          {"role":"assistant","content":"One event.","metadata":{"answeredOn":"phone","model":"nenva Cloud"}},
          {"role":"tool","content":"{}"},
          {"role":"assistant","content":"   "}]}
        """#)
        let t = PhoneThread.messages(conv)
        XCTAssertEqual(t.map(\.content), ["What is on today?", "Two tasks.", "And tomorrow?", "One event."])
        XCTAssertNil(t[1].answeredBy)
        XCTAssertEqual(t[3].answeredBy, "nenva cloud")
        XCTAssertEqual(PhoneThread.history(conv, limit: 2).map(\.content), ["And tomorrow?", "One event."])
    }

    func testAppendingStampsTheConversation() {
        let c = j(#"{"id":"c","updatedAt":"2026-01-01T00:00:00Z","messages":[{"role":"user","content":"a"}]}"#).objectValue!
        let next = PhoneThread.appending(c, ["role": .string("assistant"), "content": .string("b")], now: "2026-09-25T00:00:00Z")
        XCTAssertEqual(next["messages"]?.arrayValue?.count, 2)
        XCTAssertEqual(next["updatedAt"]?.stringValue, "2026-09-25T00:00:00Z")
    }
}
