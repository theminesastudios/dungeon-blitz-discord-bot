import {
  AutocompleteContext,
  createCommandInteraction,
  DiscordRestClient,
  MiniInteraction,
  MessageFlags,
  verifyAndParseInteraction,
} from "@minesa-org/mini-interaction";
import type {
  CommandBuilder,
  CommandInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from "@minesa-org/mini-interaction";
import { createMessageComponentInteraction } from "@minesa-org/mini-interaction/dist/utils/MessageComponentInteraction.js";
import { createModalSubmitInteraction } from "@minesa-org/mini-interaction/dist/utils/ModalSubmitInteraction.js";
import {
  InteractionResponseType,
  InteractionType,
  type APIChatInputApplicationCommandInteraction,
  type APIInteraction,
  type APIInteractionResponse,
} from "discord-api-types/v10";
import { waitUntil } from "@vercel/functions";
import { maintenanceCommand } from "../src/commands/maintenance.js";
import {
  accountCommand,
  initialPasswordButton,
  initialPasswordModal,
  resetPasswordModal,
} from "../src/commands/account.js";
import { sponsorInfoCommand } from "../src/commands/sponsor-info.js";
import { idolsCommand, handleIdolsAutocomplete } from "../src/commands/idols.js";
import {
  profileCommand,
  handleProfileAutocomplete,
} from "../src/commands/profile.js";
import {
  packsCommand,
  packsBuyComponent,
  packsShopComponent,
} from "../src/commands/packs.js";

const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
if (!applicationId || !botToken) {
  throw new Error(
    "[interactions] DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required.",
  );
}

export const rest = new DiscordRestClient({ token: botToken, applicationId });

/**
 * 0.9.0 MiniInteraction instance. The interaction dispatcher below handles
 * commands/components/modals directly (the compat file loader has no
 * autocomplete support), while this instance provides the OAuth page helpers
 * used by the other /api routes.
 */
export const mini = new MiniInteraction();

type CommandHandler = (interaction: CommandInteraction) => Promise<unknown>;
type ComponentHandler = (
  interaction: MessageComponentInteraction,
) => Promise<unknown>;
type ModalHandler = (interaction: ModalSubmitInteraction) => Promise<unknown>;
type AutocompleteHandler = (autocomplete: AutocompleteContext) => Promise<void>;

type CommandModule = { data: CommandBuilder; handler: CommandHandler };
type ComponentModule = {
  customId: string;
  handler: ComponentHandler;
};
type ModalModule = { customId: string; handler: ModalHandler };
type AutocompleteModule = { command: string; handler: AutocompleteHandler };

const commandModules: CommandModule[] = [
  maintenanceCommand,
  accountCommand,
  sponsorInfoCommand,
  idolsCommand,
  profileCommand,
  packsCommand,
];

const componentModules: ComponentModule[] = [
  initialPasswordButton,
  packsBuyComponent,
  packsShopComponent,
];

const modalModules: ModalModule[] = [
  initialPasswordModal,
  resetPasswordModal,
];

const autocompleteModules: AutocompleteModule[] = [
  { command: "idols", handler: handleIdolsAutocomplete },
  { command: "profile", handler: handleProfileAutocomplete },
];

/** Command payloads for global registration (see scripts/register.ts). */
export const commandData = commandModules.map((command) => command.data.toJSON());

const commandHandlers = new Map<string, CommandHandler>(
  commandData.map((payload, index) => [payload.name, commandModules[index].handler]),
);
const exactComponentHandlers = new Map<string, ComponentHandler>();
const prefixComponentHandlers: Array<{
  prefix: string;
  handler: ComponentHandler;
}> = [];
for (const component of componentModules) {
  if (component.customId.endsWith("*")) {
    prefixComponentHandlers.push({
      prefix: component.customId.slice(0, -1),
      handler: component.handler,
    });
  } else {
    exactComponentHandlers.set(component.customId, component.handler);
  }
}
const modalHandlers = new Map<string, ModalHandler>(
  modalModules.map((modal) => [modal.customId, modal.handler]),
);
const autocompleteHandlers = new Map<string, AutocompleteHandler>(
  autocompleteModules.map((module) => [module.command, module.handler]),
);

function matchComponentHandler(customId: string): ComponentHandler | undefined {
  const exact = exactComponentHandlers.get(customId);
  if (exact) return exact;
  for (const entry of prefixComponentHandlers) {
    if (customId.startsWith(entry.prefix)) return entry.handler;
  }
  return undefined;
}

function isDeferredResponse(response: APIInteractionResponse) {
  return (
    response.type === InteractionResponseType.DeferredChannelMessageWithSource ||
    response.type === InteractionResponseType.DeferredMessageUpdate
  );
}

function defaultAck(interaction: APIInteraction): APIInteractionResponse {
  if (interaction.type === InteractionType.MessageComponent) {
    return { type: InteractionResponseType.DeferredMessageUpdate };
  }
  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    return {
      type: InteractionResponseType.ApplicationCommandAutocompleteResult,
      data: { choices: [] },
    };
  }
  return {
    type: InteractionResponseType.DeferredChannelMessageWithSource,
    data: { flags: MessageFlags.Ephemeral },
  };
}

function responseData(response: APIInteractionResponse): object {
  return "data" in response ? response.data ?? {} : {};
}

const AUTOCOMPLETE_EMPTY: APIInteractionResponse = {
  type: InteractionResponseType.ApplicationCommandAutocompleteResult,
  data: { choices: [] },
};

/**
 * Runs a handler with the 0.9.0 response lifecycle: the first acknowledgement
 * (reply/deferReply/showModal) is committed to the HTTP response immediately so
 * Discord's 3-second window is never missed, and later editReply/followUp calls
 * go through the REST webhook endpoints.
 */
async function runWithResponseLifecycle(
  interaction: APIInteraction,
  executor: (helpers: {
    canRespond: (interactionId: string) => boolean;
    trackResponse: (
      interactionId: string,
      token: string,
      state: string,
    ) => void;
    onAck: (response: APIInteractionResponse) => void;
    sendFollowUp: (
      token: string,
      response: APIInteractionResponse,
      messageId?: string,
    ) => Promise<void>;
  }) => Promise<unknown>,
  commitInitialResponse: (response: APIInteractionResponse) => boolean,
): Promise<APIInteractionResponse | undefined> {
  let ackResponse: APIInteractionResponse | undefined;
  let committedResponse: APIInteractionResponse | undefined;
  let initialResponseCommitted = false;
  let followUpSent = false;

  const helpers = {
    canRespond: (_interactionId: string) => true,
    trackResponse: (_interactionId: string, _token: string, _state: string) => {},
    onAck: (response: APIInteractionResponse) => {
      ackResponse = response;
      if (!initialResponseCommitted && commitInitialResponse(response)) {
        initialResponseCommitted = true;
        committedResponse = response;
      }
    },
    sendFollowUp: async (
      token: string,
      response: APIInteractionResponse,
      messageId?: string,
    ) => {
      // Before the initial response exists, collapse the edit into the initial
      // response instead of hitting the webhook endpoints too early.
      if (!initialResponseCommitted) {
        ackResponse = response;
        followUpSent = true;
        return;
      }
      const data = responseData(response);
      if (messageId === "@original") {
        await rest.editOriginal(token, data);
      } else {
        await rest.createFollowup(token, data);
      }
      followUpSent = true;
    },
  };

  const result = await executor(helpers) as APIInteractionResponse | undefined;

  if (
    initialResponseCommitted &&
    result &&
    !followUpSent &&
    committedResponse &&
    isDeferredResponse(committedResponse) &&
    !isDeferredResponse(result)
  ) {
    await rest.editOriginal(interaction.token, responseData(result));
    return undefined;
  }

  if (initialResponseCommitted) return undefined;
  return (
    (result as APIInteractionResponse | undefined) ?? ackResponse ?? undefined
  );
}

async function dispatch(
  interaction: APIInteraction,
  commitInitialResponse: (response: APIInteractionResponse) => boolean,
): Promise<APIInteractionResponse | undefined> {
  if (interaction.type === InteractionType.ApplicationCommand) {
    const handler = commandHandlers.get(interaction.data.name);
    if (!handler) return undefined;
    // Every registered command is a chat-input command.
    return runWithResponseLifecycle(
      interaction,
      (helpers) =>
        handler(
          createCommandInteraction(
            interaction as APIChatInputApplicationCommandInteraction,
            helpers,
          ),
        ),
      commitInitialResponse,
    );
  }

  if (interaction.type === InteractionType.MessageComponent) {
    const handler = matchComponentHandler(interaction.data.custom_id);
    if (!handler) return undefined;
    return runWithResponseLifecycle(
      interaction,
      (helpers) =>
        handler(createMessageComponentInteraction(interaction, helpers)),
      commitInitialResponse,
    );
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    const handler = modalHandlers.get(interaction.data.custom_id);
    if (!handler) return undefined;
    return runWithResponseLifecycle(
      interaction,
      (helpers) => handler(createModalSubmitInteraction(interaction, helpers)),
      commitInitialResponse,
    );
  }

  if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
    const handler = autocompleteHandlers.get(interaction.data.name);
    if (!handler) return AUTOCOMPLETE_EMPTY;
    const autocomplete = new AutocompleteContext(interaction);
    await handler(autocomplete);
    return autocomplete.result ?? AUTOCOMPLETE_EMPTY;
  }

  return undefined;
}

export default async function handler(request: any, response: any) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);
  const signature = String(request.headers["x-signature-ed25519"] ?? "");
  const timestamp = String(request.headers["x-signature-timestamp"] ?? "");
  const publicKey = process.env.DISCORD_PUBLIC_KEY?.trim() ?? "";

  if (!publicKey) {
    return response
      .status(500)
      .json({ error: "DISCORD_PUBLIC_KEY is not configured" });
  }
  if (!signature || !timestamp) {
    return response
      .status(401)
      .json({ error: "Missing Discord signature headers" });
  }

  let interaction: APIInteraction;
  try {
    interaction = await verifyAndParseInteraction({
      body: rawBody,
      signature,
      timestamp,
      publicKey,
    });
  } catch {
    return response
      .status(401)
      .json({ error: "Invalid Discord interaction signature" });
  }

  if (interaction.type === InteractionType.Ping) {
    return response.status(200).json({ type: InteractionResponseType.Pong });
  }

  let responseSent = false;
  let resolveCommitted: (value: boolean) => void;
  const committedPromise = new Promise<boolean>((resolve) => {
    resolveCommitted = resolve;
  });
  const commitInitialResponse = (ack: APIInteractionResponse) => {
    if (responseSent) return false;
    responseSent = true;
    resolveCommitted!(true);
    response.status(200).json(ack);
    return true;
  };

  const dispatchPromise = dispatch(interaction, commitInitialResponse).catch(
    (error) => {
      console.error("[interactions] Interaction handling failed:", error);
      return undefined;
    },
  );

  const settled = await Promise.race([
    dispatchPromise.then(
      (result) => ({ kind: "result" as const, result }),
      (error) => ({ kind: "error" as const, error }),
    ),
    committedPromise.then(() => ({ kind: "committed" as const })),
  ]);

  if (settled.kind === "committed") {
    try {
      waitUntil(dispatchPromise);
    } catch {
      // Vercel-only helper; the promise keeps running regardless.
    }
    return;
  }

  if (settled.kind === "error") {
    console.error("[interactions] Interaction handling failed:", settled.error);
  }
  if (!responseSent) {
    responseSent = true;
    const result = settled.kind === "result" ? settled.result : undefined;
    response.status(200).json(result ?? defaultAck(interaction));
  }
}
