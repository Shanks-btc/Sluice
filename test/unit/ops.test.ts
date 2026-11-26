// What the facilitator and the tool server share for running as a service: a request id, a bearer check, and counters and gauges as text.
import { expect } from "chai";
import { REQUEST_ID, RequestCounter, bearerMatches, renderGauges, requestIdFor, routeLabel } from "@sluice/sdk";

describe("Service basics: a request id on every request", () => {
  const make = () => "generated-0001";

  it("keeps a caller's id when it is well formed, and replaces one that is not, so a log line cannot be forged through it", () => {
    expect(requestIdFor("abcd-1234_ef.gh", make)).to.equal("abcd-1234_ef.gh");
    expect(requestIdFor("A".repeat(64), make)).to.equal("A".repeat(64));
    for (const bad of ["short", "A".repeat(65), "has space 1234", "line\nbreak123", 'quote"12345678', "semi;colon1234", "", undefined]) {
      expect(requestIdFor(bad, make), JSON.stringify(bad)).to.equal("generated-0001");
    }
    expect(requestIdFor(["abcd-1234-first", "other-id-9999"], make)).to.equal("abcd-1234-first");
    expect(requestIdFor([], make)).to.equal("generated-0001");
    expect(REQUEST_ID.test("abcdefgh")).to.equal(true);
    expect(REQUEST_ID.test("abcdefg")).to.equal(false);
  });

  it("makes a different id each time it has to", () => {
    const a = requestIdFor(undefined);
    const b = requestIdFor(undefined);
    expect(a).to.not.equal(b);
    expect(a).to.match(/^[0-9a-f-]{36}$/);
  });
});

describe("Service basics: the private metrics path needs its token", () => {
  const token = "t".repeat(24) + "-secret";

  it("opens for exactly the configured token, as a Bearer header", () => {
    expect(bearerMatches(`Bearer ${token}`, token)).to.equal(true);
    expect(bearerMatches(`Bearer ${token}x`, token)).to.equal(false);
    expect(bearerMatches(`Bearer ${token.slice(0, -1)}`, token)).to.equal(false);
    expect(bearerMatches(`Bearer ${token.toUpperCase()}`, token)).to.equal(false);
    expect(bearerMatches(token, token)).to.equal(false);
    expect(bearerMatches(`bearer ${token}`, token)).to.equal(false);
    expect(bearerMatches(`Basic ${token}`, token)).to.equal(false);
    expect(bearerMatches(`Bearer  ${token}`, token)).to.equal(false);
    expect(bearerMatches(`Bearer ${token} extra`, token)).to.equal(false);
    expect(bearerMatches(undefined, token)).to.equal(false);
    expect(bearerMatches("", token)).to.equal(false);
  });

  it("opens for nothing when no token is configured, so an unset token is never a way in", () => {
    expect(bearerMatches("Bearer anything", undefined)).to.equal(false);
    expect(bearerMatches("Bearer ", "")).to.equal(false);
    expect(bearerMatches("Bearer undefined", undefined)).to.equal(false);
  });
});

describe("Service basics: counters and gauges as text", () => {
  const known = ["/health", "/status", "/verify"] as const;

  it("names a route only from the list, so a client cannot make a counter grow by inventing paths", () => {
    expect(routeLabel("/health", known)).to.equal("/health");
    expect(routeLabel("/status/0xabc", known)).to.equal("/status");
    expect(routeLabel("/status", known)).to.equal("/status");
    expect(routeLabel("/nope", known)).to.equal("other");
    expect(routeLabel("/health/extra", known)).to.equal("other");
    expect(routeLabel("/status/x", ["/health"])).to.equal("other");
  });

  it("counts requests by route and status class, and writes them sorted, so the same counts give the same text", () => {
    const c = new RequestCounter();
    c.record("/verify", 200);
    c.record("/verify", 200);
    c.record("/verify", 429);
    c.record("/health", 503);
    c.record("other", 404);
    expect(c.total()).to.equal(5);
    expect(c.lines("m_total")).to.deep.equal([
      "# TYPE m_total counter",
      'm_total{route="/health",status="5xx"} 1',
      'm_total{route="/verify",status="2xx"} 2',
      'm_total{route="/verify",status="4xx"} 1',
      'm_total{route="other",status="4xx"} 1',
    ]);
    expect(new RequestCounter().lines("m_total")).to.deep.equal(["# TYPE m_total counter"]);
  });

  it("writes a gauge a line, leaves out one it does not know rather than write zero, and writes a flag as 0 or 1", () => {
    const out = renderGauges([
      { name: "g_flag", value: true, help: "A flag." },
      { name: "g_flag", value: false, labels: { kind: "b" } },
      { name: "g_big", value: 123456789012345678901234567890n },
      { name: "g_unknown", value: null },
      { name: "g_missing", value: undefined },
      { name: "g_zero", value: 0 },
    ]);
    expect(out).to.deep.equal([
      "# HELP g_flag A flag.",
      "# TYPE g_flag gauge",
      "g_flag 1",
      'g_flag{kind="b"} 0',
      "# TYPE g_big gauge",
      "g_big 123456789012345678901234567890",
      "# TYPE g_zero gauge",
      "g_zero 0",
    ]);
  });

  it("cleans a label so it cannot break the line", () => {
    const out = renderGauges([{ name: "g", value: 1, labels: { "bad key": 'v"al\nue' } }]);
    expect(out[1]).to.equal('g{bad_key="v_al_ue"} 1');
  });
});
