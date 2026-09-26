import XCTest
@testable import AnjadheCore

/// The phone's own AI (docs/MOBILE_NATIVE.md "M5", laws P1-P5 in PhoneAI.swift).
final class PhoneAITests: XCTestCase {

    private func j(_ s: String) -> JSONValue { try! JSONValue.parse(s) }

    // P1: absent, null, or a non-cloud engine all mean OFF.
    func testChoiceOffUnlessNenvaCloud() {
        XCTAssertNil(PhoneModelChoice.from([:]))
        XCTAssertNil(PhoneModelChoice.from(["fallback": .null]))
        XCTAssertNil(PhoneModelChoice.from(j(#"{"fallback":{"engine":"openai","model":"gpt"}}"#).objectValue!))
        let c = PhoneModelChoice.from(j(#"{"fallback":{"engine":"anjadhe","model":"anjadhe-cloud-large","label":"Large"}}"#).objectValue!)
        XCTAssertEqual(c?.model, "anjadhe-cloud-large")
        XCTAssertEqual(c?.displayName, "nenva Cloud · Large")
        XCTAssertEqual(PhoneModelChoice(engine: "anjadhe", model: "anjadhe-cloud", label: "nenva Cloud").displayName, "nenva Cloud")
        // Round-trips through the blob the Mac also writes.
        XCTAssertEqual(PhoneModelChoice.from(c!.blob(now: "2026-09-25T00:00:00Z")), c)
    }

    // P3: journal and wellness are off unless turned on; notes on unless off.
    func testPrivacyClasses() {
        XCTAssertTrue(PhonePrivacy.allows("notes", settings: [:]))
        XCTAssertFalse(PhonePrivacy.allows("journal", settings: [:]))
        XCTAssertFalse(PhonePrivacy.allows("wellness", settings: [:]))
        let s = j(#"{"classes":{"journal":true,"notes":false}}"#).objectValue!
        XCTAssertTrue(PhonePrivacy.allows("journal", settings: s))
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
        XCTAssertEqual(t[3].answeredBy, "nenva Cloud")
        XCTAssertEqual(PhoneThread.history(conv, limit: 2).map(\.content), ["And tomorrow?", "One event."])
    }

    func testAppendingStampsTheConversation() {
        let c = j(#"{"id":"c","updatedAt":"2026-01-01T00:00:00Z","messages":[{"role":"user","content":"a"}]}"#).objectValue!
        let next = PhoneThread.appending(c, ["role": .string("assistant"), "content": .string("b")], now: "2026-09-25T00:00:00Z")
        XCTAssertEqual(next["messages"]?.arrayValue?.count, 2)
        XCTAssertEqual(next["updatedAt"]?.stringValue, "2026-09-25T00:00:00Z")
    }
}
