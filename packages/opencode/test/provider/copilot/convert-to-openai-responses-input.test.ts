import { convertToOpenAIResponsesInput } from "@/provider/sdk/copilot/responses/convert-to-openai-responses-input"
import { describe, test, expect } from "bun:test"

describe("convertToOpenAIResponsesInput - reasoning round-trip", () => {
  test("BUG: reasoning parts with encrypted_content and itemId are preserved when store=false", async () => {
    const result = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "thinking about this...",
              providerOptions: {
                copilot: {
                  itemId: "rs_abc123",
                  reasoningEncryptedContent: "encrypted_blob_data",
                },
              },
            },
            { type: "text", text: "hi there" },
          ],
        },
      ],
      systemMessageMode: "system",
      store: false,
    })

    const reasoning = result.input.find((item: any) => item.type === "reasoning")
    expect(reasoning).toBeDefined()
    expect(reasoning.encrypted_content).toBe("encrypted_blob_data")
    expect(reasoning.summary).toEqual([{ type: "summary_text", text: "thinking about this..." }])
  })

  test("reasoning parts with encrypted_content and itemId are preserved when store=true", async () => {
    const result = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "thinking about this...",
              providerOptions: {
                copilot: {
                  itemId: "rs_abc123",
                  reasoningEncryptedContent: "encrypted_blob_data",
                },
              },
            },
            { type: "text", text: "hi there" },
          ],
        },
      ],
      systemMessageMode: "system",
      store: true,
    })

    const ref = result.input.find((item: any) => item.type === "item_reference")
    expect(ref).toBeDefined()
    expect((ref as any).id).toBe("rs_abc123")
  })

  test("BUG: reasoning parts without itemId are silently dropped when store=false", async () => {
    const result = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "thinking about this...",
            },
            { type: "text", text: "hi there" },
          ],
        },
      ],
      systemMessageMode: "system",
      store: false,
    })

    const reasoning = result.input.find((item: any) => item.type === "reasoning")
    expect(reasoning).toBeUndefined()

    expect(result.warnings.some((w) => w.message.includes("Non-OpenAI reasoning parts are not supported"))).toBe(true)
  })

  test("BUG: reasoning with encrypted_content but no itemId still drops data", async () => {
    const result = await convertToOpenAIResponsesInput({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "thinking...",
              providerOptions: {
                copilot: {
                  reasoningEncryptedContent: "encrypted_but_no_item_id",
                },
              },
            },
            { type: "text", text: "response" },
          ],
        },
      ],
      systemMessageMode: "system",
      store: false,
    })

    const reasoning = result.input.find((item: any) => item.type === "reasoning")
    expect(reasoning).toBeDefined()
    expect((reasoning as any).encrypted_content).toBe("encrypted_but_no_item_id")
  })
})
