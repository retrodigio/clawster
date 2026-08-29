import { describe, expect, test } from "bun:test";
import { interpretCheckin, CHECKIN_SCHEMA } from "../src/core/scheduler.ts";

describe("interpretCheckin — schema path", () => {
  test("checkin:false stays silent", () => {
    expect(interpretCheckin("{}", { checkin: false })).toEqual({ send: false, via: "schema" });
  });

  test("checkin:true sends the message field", () => {
    const d = interpretCheckin("ignored", { checkin: true, message: "Build is red on main." });
    expect(d).toEqual({ send: true, message: "Build is red on main.", via: "schema" });
  });

  test("checkin:true with no message is a contradiction — believe the absence", () => {
    // The flag says speak, but there is literally nothing to send. Posting an
    // empty message is worse than staying quiet.
    expect(interpretCheckin("", { checkin: true }).send).toBe(false);
    expect(interpretCheckin("", { checkin: true, message: "   " }).send).toBe(false);
  });

  test("the old sentinel smuggled into the message field still means silence", () => {
    // A task prompt that predates the schema can push the model to put
    // NO_CHECKIN in `message` rather than setting the flag.
    expect(interpretCheckin("", { checkin: true, message: "NO_CHECKIN" }).send).toBe(false);
  });
});

describe("interpretCheckin — JSON-in-text fallback", () => {
  test("reads the object when the SDK surfaced no structured value", () => {
    const d = interpretCheckin('{"checkin":true,"message":"Deploy finished."}');
    expect(d).toEqual({ send: true, message: "Deploy finished.", via: "json" });
  });

  test("a JSON object that says false stays silent", () => {
    expect(interpretCheckin('{"checkin":false}').send).toBe(false);
  });

  test("malformed JSON is never posted as prose", () => {
    // This is the failure that matters: without the guard, a truncated object
    // would be sent to a group chat verbatim.
    const d = interpretCheckin('{"checkin":true,"message":"half a mess');
    expect(d.send).toBe(false);
    expect(d.via).toBe("json");
  });

  test("a JSON object missing the checkin field is not a check-in", () => {
    expect(interpretCheckin('{"message":"orphaned"}').send).toBe(false);
  });
});

describe("interpretCheckin — legacy sentinel", () => {
  test("bare NO_CHECKIN stays silent", () => {
    expect(interpretCheckin("NO_CHECKIN").send).toBe(false);
    expect(interpretCheckin("NO_CHECKIN — nothing to report").send).toBe(false);
  });

  test("empty output stays silent", () => {
    expect(interpretCheckin("   ").send).toBe(false);
  });

  test("prose from a pre-schema task is still delivered", () => {
    const d = interpretCheckin("  IronRod build is red.  ");
    expect(d).toEqual({ send: true, message: "IronRod build is red.", via: "sentinel" });
  });

  test("structured wins over text when both are present", () => {
    expect(interpretCheckin("some prose", { checkin: false }).send).toBe(false);
  });
});

describe("CHECKIN_SCHEMA", () => {
  test("requires checkin and forbids extra fields", () => {
    expect(CHECKIN_SCHEMA.type).toBe("json_schema");
    expect(CHECKIN_SCHEMA.schema.required).toEqual(["checkin"]);
    expect(CHECKIN_SCHEMA.schema.additionalProperties).toBe(false);
  });
});
