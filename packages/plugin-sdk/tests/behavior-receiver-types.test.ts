/**
 * The behavior-receiver payload and reply types, held to the fixtures' key
 * lists. Each sample is a full object of its type (`Required<…>` plus the
 * excess-property check), so a key the type adds or drops shows up as a
 * key list that no longer equals the fixtures'.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BEHAVIOR_WEBHOOK_FIXTURES as fixtures,
  createNonceStore,
  createReceiver,
  verifyRequest,
  type BehaviorCallback,
  type BehaviorReply,
  type BehaviorReplyEmbed,
  type BehaviorWebhookAttachment,
  type BehaviorWebhookPayload,
  type BehaviorWebhookUser,
  type CommandTriggerMeta,
  type MessageTriggerMeta,
} from "../src/behavior-receiver/index.js";

const keys = (o: object) => Object.keys(o).sort();
const sorted = (list: readonly string[]) => [...list].sort();

const user: Required<BehaviorWebhookUser> = {
  id: "1",
  username: "mika",
  global_name: null,
  discriminator: "0",
  avatar: null,
};

const attachment: Required<BehaviorWebhookAttachment> = {
  id: "2",
  url: "https://cdn.example/a.png",
  filename: "a.png",
  content_type: "image/png",
  size: 1,
};

const callback: Required<BehaviorCallback> = {
  token: "t",
  expires_at: "2026-11-10T00:15:00.000Z",
  api_base: "https://karyl.example",
};

const messageMeta: Required<MessageTriggerMeta> = {
  user,
  message_id: "3",
  channel_id: "4",
  guild_id: null,
  behavior_id: 5,
  attachments: [attachment],
  captures: [],
  callback,
};

const commandMeta: Required<CommandTriggerMeta> = {
  interaction_id: "6",
  application_id: "7",
  command_name: "weather",
  sub_command_name: null,
  sub_command_group: null,
  guild_id: null,
  channel_id: "4",
  user,
  locale: null,
  options: [],
  behavior_id: 5,
  attachments: [],
  callback,
};

const payload: Required<BehaviorWebhookPayload> = {
  content: "!hi",
  username: "mika",
  avatar_url: "",
  _meta: messageMeta,
};

const embed: Required<BehaviorReplyEmbed> = {
  title: "",
  description: "",
  url: "",
  color: 0,
  timestamp: "",
  footer: { text: "" },
  image: { url: "" },
  thumbnail: { url: "" },
  author: { name: "" },
  fields: [],
};

const reply: Required<BehaviorReply> = {
  content: "",
  embeds: [embed],
  components: [],
  ephemeral: true,
  flags: 0,
  defer: true,
};

describe("behavior-receiver types, against the fixtures", () => {
  const { request, response } = fixtures;

  it("type the request's keys", () => {
    assert.deepEqual(keys(payload), sorted(request.topLevelKeys));
    assert.deepEqual(keys(messageMeta), sorted(request.patternMetaKeys));
    assert.deepEqual(keys(commandMeta), sorted(request.slashMetaKeys));
    assert.deepEqual(keys(user), sorted(request.userKeys));
    assert.deepEqual(keys(attachment), sorted(request.attachmentKeys));
    assert.deepEqual(keys(callback), sorted(request.callbackKeys));
  });

  it("type the reply's fields and embed whitelist", () => {
    assert.deepEqual(keys(reply), sorted(response.fields));
    assert.deepEqual(keys(embed), sorted(response.embedWhitelist));
  });
});

describe("behavior-receiver options", () => {
  it("take a mode that is only known at run time", async () => {
    // e.g. read from config: the type checker sees "token" | "hmac"
    const mode = (
      process.env.KARYL_TEST_MODE === "token" ? "token" : "hmac"
    ) as "token" | "hmac";
    const handler = createReceiver({
      mode,
      secret: "s",
      path: "/hook",
      answer: () => null,
    });
    assert.equal(typeof handler, "function");
    const result = await verifyRequest({
      mode,
      secret: "s",
      path: "/hook",
      headers: {},
      body: "",
      nonceStore: createNonceStore(),
    });
    assert.equal(result.ok, false);
  });
});
