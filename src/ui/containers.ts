import {
	ActionRowBuilder,
	ContainerBuilder,
	InteractionFlags,
	SectionBuilder,
	SeparatorBuilder,
	SeparatorSpacingSize,
	TextDisplayBuilder,
	ThumbnailBuilder,
} from "@minesa-org/mini-interaction";
import type { MessageActionRowComponent } from "@minesa-org/mini-interaction";
import type { APIButtonComponent, APISectionAccessoryComponent } from "discord-api-types/v10";
import { MessageFlags } from "discord-api-types/v10";

/**
 * The bot's design language: every reply is a Components V2 container. These helpers keep the
 * colours, spacing and flag handling in one place so each command only describes its content.
 */

export const V2_FLAGS = MessageFlags.IsComponentsV2;
export const V2_EPHEMERAL_FLAGS = (MessageFlags.IsComponentsV2 |
	InteractionFlags.Ephemeral) as MessageFlags;

export const COLORS = {
	brand: 0x5865f2,
	success: 0x2ecc71,
	danger: 0xe74c3c,
	warning: 0xf1c40f,
	muted: 0x99aab5,
} as const;

export function text(content: string): TextDisplayBuilder {
	return new TextDisplayBuilder().setContent(content);
}

export function divider(spacing: SeparatorSpacingSize = SeparatorSpacingSize.Small): SeparatorBuilder {
	return new SeparatorBuilder().setDivider(true).setSpacing(spacing);
}

export function gap(): SeparatorBuilder {
	return new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small);
}

/** A text block with a button or thumbnail beside it. */
export function section(
	content: string,
	accessory: APISectionAccessoryComponent | { toJSON(): APISectionAccessoryComponent },
): SectionBuilder {
	return new SectionBuilder().addComponent(text(content)).setAccessory(accessory);
}

export function thumbnail(url: string, description?: string): ThumbnailBuilder {
	return new ThumbnailBuilder().setMedia({ url }).setDescription(description ?? null);
}

export function buttonRow(...buttons: Array<APIButtonComponent | { toJSON(): APIButtonComponent }>) {
	return new ActionRowBuilder<MessageActionRowComponent>().addComponents(
		...(buttons as Array<MessageActionRowComponent>),
	);
}

/**
 * A one-container message: a title, a body, and optional controls. Used for every short
 * answer — errors, confirmations, results — so they all look the same.
 */
export function notice(
	color: number,
	title: string,
	body: string | string[],
	rows: Array<ActionRowBuilder<MessageActionRowComponent>> = [],
): ContainerBuilder {
	const container = new ContainerBuilder()
		.setAccentColor(color)
		.addComponent(text(`### ${title}`))
		.addComponent(text(Array.isArray(body) ? body.join("\n") : body));
	for (const row of rows) container.addComponent(row);
	return container;
}

/** Message payload for one or more containers, ephemeral by default. */
export function v2(
	containers: ContainerBuilder | ContainerBuilder[],
	options: { ephemeral?: boolean } = {},
) {
	return {
		components: Array.isArray(containers) ? containers : [containers],
		flags: options.ephemeral === false ? V2_FLAGS : V2_EPHEMERAL_FLAGS,
	};
}

/** Same as `v2` for `interaction.update`, which must not resend the ephemeral flag. */
export function v2Update(containers: ContainerBuilder | ContainerBuilder[]) {
	return {
		components: Array.isArray(containers) ? containers : [containers],
		flags: V2_FLAGS,
	};
}

export function errorNotice(body: string): ReturnType<typeof v2> {
	return v2(notice(COLORS.danger, "Something went wrong", body));
}

export function formatNumber(value: number): string {
	return Math.max(0, Math.round(value)).toLocaleString("en-US");
}
