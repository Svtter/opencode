import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import path from "path"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util/log"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-reasoner"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-reasoner": {
          id: "test-reasoner",
          name: "Test Reasoner",
          attachment: false,
          reasoning: true,
          temperature: false,
          tool_call: true,
          interleaved: { field: "reasoning_content" },
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(TestLLMServer.layer, SessionProcessor.layer.pipe(Layer.provideMerge(deps)))

const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

const user = Effect.fn("TestReasoning.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestReasoning.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

it.live(
  "BUG: reasoning_content not round-tripped in multi-turn conversation with interleaved model",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          yield* llm.reason("thinking step 1", { text: "answer 1", usage: { input: 50, output: 20 } })
          yield* llm.text("answer 2")

          const chat = yield* session.create({})

          const parent1 = yield* user(chat.id, "turn 1")
          const msg1 = yield* assistant(chat.id, parent1.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)

          const handle1 = yield* processors.create({
            assistantMessage: msg1,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle1.process({
            user: {
              id: parent1.id,
              sessionID: chat.id,
              role: "user",
              time: parent1.time,
              agent: parent1.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: {
              name: "build",
              mode: "primary",
              options: {},
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            },
            system: [],
            messages: [{ role: "user", content: "turn 1" }],
            tools: {},
          } satisfies LLM.StreamInput)

          const calls1 = yield* llm.calls
          expect(calls1).toBe(1)

          const parent2 = yield* user(chat.id, "turn 2")
          const msg2 = yield* assistant(chat.id, parent2.id, path.resolve(dir))

          const handle2 = yield* processors.create({
            assistantMessage: msg2,
            sessionID: chat.id,
            model: mdl,
          })

          yield* handle2.process({
            user: {
              id: parent2.id,
              sessionID: chat.id,
              role: "user",
              time: parent2.time,
              agent: parent2.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies MessageV2.User,
            sessionID: chat.id,
            model: mdl,
            agent: {
              name: "build",
              mode: "primary",
              options: {},
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            },
            system: [],
            messages: [{ role: "user", content: "turn 2" }],
            tools: {},
          } satisfies LLM.StreamInput)

          const inputs = yield* llm.inputs
          expect(inputs.length).toBeGreaterThanOrEqual(2)

          const chatInputs = inputs.filter((body: any) => body.messages && !JSON.stringify(body).includes("Generate a title"))
          expect(chatInputs.length).toBeGreaterThanOrEqual(2)

          const secondRequest = chatInputs[1]
          const messages = secondRequest.messages as Array<any>

          const assistantMsg = messages.find((m: any) => m.role === "assistant")

          expect(assistantMsg).toBeDefined()

          const hasReasoningContent =
            typeof assistantMsg.reasoning_content === "string" && assistantMsg.reasoning_content.length > 0

          const hasReasoningInContent = Array.isArray(assistantMsg.content)
            ? assistantMsg.content.some(
                (c: any) =>
                  (typeof c === "string" && c.length > 0) ||
                  (c && typeof c === "object" && c.type === "reasoning"),
              )
            : typeof assistantMsg.content === "string" && assistantMsg.content.length > 0

          expect(hasReasoningContent || hasReasoningInContent).toBe(true)
        }),
      { git: true, config: (url) => providerCfg(url) },
    ),
)
