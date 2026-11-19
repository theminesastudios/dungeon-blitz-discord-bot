export const GAME_PLAY_URL = "https://dungeonblitzr.theminesa.studio/web";

export const DISCORD_LOGIN_HINT = "You can also log in with Discord in-game.";

export function renderGamePlayLink(showPlayLink: boolean): string {
	return showPlayLink
		? `<p><a href="${GAME_PLAY_URL}" style="color:#a5b4fc">Play in browser</a></p><p>${DISCORD_LOGIN_HINT}</p>`
		: "";
}
