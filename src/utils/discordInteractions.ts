type MemberLike = {
  permissions?: string | number | bigint;
  roles?: readonly string[];
  user?: { id?: string } | null;
} | null;

type InteractionLike = {
  member?: MemberLike;
  user?: { id?: string } | null;
};

/** Discord permission bits we check by hand; the interaction payload is a raw bitfield. */
export const ADMINISTRATOR_PERMISSION = 1n << 3n;
export const MANAGE_GUILD_PERMISSION = 1n << 5n;

/**
 * Reads one permission bit off the invoking member. Discord sends permissions as a
 * stringified bitfield, but never on every interaction (DM invocations, some component
 * updates), so a missing value is "not permitted" rather than a thrown error.
 */
export function hasPermission(
  interaction: InteractionLike,
  bit: bigint,
): boolean {
  const permissions = interaction.member?.permissions;
  if (permissions === undefined || permissions === null) return false;
  return (BigInt(permissions) & bit) === bit;
}

export function isAdministrator(interaction: InteractionLike) {
  return hasPermission(interaction, ADMINISTRATOR_PERMISSION);
}

/**
 * Staff gate used by the tools that act on another player. Discord grants administrators
 * every permission implicitly, so the payload carries the Manage Server bit for them too;
 * checking both keeps the intent readable and covers a member whose role grants only
 * Manage Server.
 */
export function canManageGuild(interaction: InteractionLike): boolean {
  return (
    hasPermission(interaction, MANAGE_GUILD_PERMISSION) ||
    isAdministrator(interaction)
  );
}

export function interactionDiscordId(interaction: InteractionLike): string {
  return String(interaction.member?.user?.id ?? interaction.user?.id ?? "").trim();
}

/** Guild members carry their role snowflakes on the interaction payload. */
export function getMemberRoleIds(interaction: InteractionLike): string[] {
  const roles = interaction.member?.roles;
  return Array.isArray(roles) ? roles.map(String) : [];
}

/** The requester's display name, used to make operator log entries readable. */
export function interactionActorLabel(interaction: InteractionLike & {
  member?: (MemberLike & { nick?: string | null }) | null;
}): string {
  const id = interactionDiscordId(interaction);
  const member = interaction.member as (MemberLike & { nick?: string | null }) | null;
  const name = String(member?.nick ?? "").trim();
  return id ? (name ? `${name} (<@${id}>)` : `<@${id}>`) : "unknown";
}
