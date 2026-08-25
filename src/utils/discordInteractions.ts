type MemberLike = {
  permissions?: string | number | bigint;
  roles?: readonly string[];
  user?: { id?: string } | null;
} | null;

type InteractionLike = {
  member?: MemberLike;
  user?: { id?: string } | null;
};

export function isAdministrator(interaction: InteractionLike) {
  const permissions = interaction.member?.permissions;
  if (permissions === undefined || permissions === null) return false;
  return (BigInt(permissions) & 8n) === 8n;
}

export function interactionDiscordId(interaction: InteractionLike): string {
  return String(interaction.member?.user?.id ?? interaction.user?.id ?? "").trim();
}

/** Guild members carry their role snowflakes on the interaction payload. */
export function getMemberRoleIds(interaction: InteractionLike): string[] {
  const roles = interaction.member?.roles;
  return Array.isArray(roles) ? roles.map(String) : [];
}
