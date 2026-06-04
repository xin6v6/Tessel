import { describe, it, expect, afterEach } from "bun:test";
import { LLMClient } from "../src/llm/client.ts";
import { humanMsg, systemMsg, aiMsg, toolMsg } from "../src/llm/messages.ts";

// ── mock fetch ───────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let captured: { url: string; body: any } | null = null;

function mockFetch(handler: (body: any) => { status?: number; json?: any }) {
  globalThis.fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    captured = { url, body };
    const { status = 200, json = {} } = handler(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  captured = null;
});

const cfg = { model: "test-model", apiKey: "sk-x", baseURL: "https://api.example.com/v1" };

function chatReply(content: string, usage?: any) {
  return { choices: [{ message: { content }, finish_reason: "stop" }], usage, model: "test-model" };
}

describe("LLMClient.invoke — 请求构造", () => {
  it("角色映射 human→user / system→system / ai→assistant / tool→tool", async () => {
    mockFetch(() => ({ json: chatReply("ok") }));
    const c = new LLMClient(cfg);
    await c.invoke([
      systemMsg("s"), humanMsg("h"),
      aiMsg("a", { tool_calls: [{ id: "t1", name: "foo", args: { x: 1 } }] }),
      toolMsg("result", "t1"),
    ]);
    const roles = captured!.body.messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    // ai 的 tool_calls 映射成 OpenAI 格式
    const asst = captured!.body.messages[2];
    expect(asst.tool_calls[0]).toEqual({
      id: "t1", type: "function", function: { name: "foo", arguments: '{"x":1}' },
    });
    // tool 消息带 tool_call_id
    expect(captured!.body.messages[3].tool_call_id).toBe("t1");
  });

  it("URL 拼 /chat/completions；temperature/maxTokens 进 body", async () => {
    mockFetch(() => ({ json: chatReply("ok") }));
    const c = new LLMClient({ ...cfg, temperature: 0.3, maxTokens: 256 });
    await c.invoke([humanMsg("h")]);
    expect(captured!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(captured!.body.temperature).toBe(0.3);
    expect(captured!.body.max_tokens).toBe(256);
  });

  it("modelKwargs 展开到 body 顶层（thinking 透传）", async () => {
    mockFetch(() => ({ json: chatReply("ok") }));
    const c = new LLMClient({ ...cfg, modelKwargs: { thinking: { type: "disabled" } } });
    await c.invoke([humanMsg("h")]);
    expect(captured!.body.thinking).toEqual({ type: "disabled" });
  });

  it("name 不发给 provider（消息里就不带）", async () => {
    mockFetch(() => ({ json: chatReply("ok") }));
    const c = new LLMClient(cfg);
    await c.invoke([humanMsg("h", { name: "Xin" })]);
    expect(captured!.body.messages[0].name).toBeUndefined();
  });
});

describe("LLMClient.invoke — 响应解析", () => {
  it("token usage 同时填 usage_metadata 和 response_metadata.tokenUsage", async () => {
    mockFetch(() => ({ json: chatReply("hi", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) }));
    const c = new LLMClient(cfg);
    const r = await c.invoke([humanMsg("h")]);
    expect(r.content).toBe("hi");
    expect(r.usage_metadata).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    expect((r.response_metadata as any).tokenUsage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("解析 tool_calls（arguments JSON 反序列化成 args）", async () => {
    mockFetch(() => ({
      json: { choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "send", arguments: '{"to":"#x"}' } }] } }] },
    }));
    const c = new LLMClient(cfg);
    const r = await c.invoke([humanMsg("h")]);
    expect(r.tool_calls).toEqual([{ id: "c1", name: "send", args: { to: "#x" } }]);
  });
});

describe("LLMClient — 错误处理", () => {
  it("4xx 不重试，直接抛", async () => {
    let calls = 0;
    mockFetch(() => { calls++; return { status: 400, json: { error: "bad" } }; });
    const c = new LLMClient({ ...cfg, maxRetries: 2 });
    await expect(c.invoke([humanMsg("h")])).rejects.toThrow(/400/);
    expect(calls).toBe(1); // 没重试
  });

  it("5xx 重试到 maxRetries 后抛", async () => {
    let calls = 0;
    mockFetch(() => { calls++; return { status: 500, json: { error: "boom" } }; });
    const c = new LLMClient({ ...cfg, maxRetries: 2 });
    await expect(c.invoke([humanMsg("h")])).rejects.toThrow(/500/);
    expect(calls).toBe(3); // 首次 + 2 重试
  });
});

describe("LLMClient.invokeStructured", () => {
  it("强制 function calling，解析 args 后 schema 校验", async () => {
    mockFetch((body) => {
      // 断言强制了 tool_choice
      expect(body.tool_choice.function.name).toBe("submit");
      return { json: { choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "submit", arguments: '{"msg":"done","ok":true}' } }] } }] } };
    });
    const c = new LLMClient(cfg);
    const schema = { parse: (d: any) => ({ msg: String(d.msg), ok: Boolean(d.ok) }) };
    const out = await c.invokeStructured([humanMsg("h")], schema, {
      name: "submit",
      parameters: { type: "object", properties: { msg: { type: "string" }, ok: { type: "boolean" } } },
    });
    expect(out).toEqual({ msg: "done", ok: true });
  });
});
