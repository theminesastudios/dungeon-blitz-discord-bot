import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	CommandBuilder,
	LabelBuilder,
	MiniInteraction,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type CommandInteraction,
	type ModalSubmitInteraction,
} from "@minesa-org/mini-interaction";
import { verifyKey } from "discord-interactions";
import type { APIButtonComponent } from "discord-api-types/v10";
import { getSponsorDonationInfo } from "../src/utils/githubSponsors.js";
import {
	adjustMammothIdols,
	getPlayerProfile,
	searchGameWallets,
	searchPlayers,
} from "../src/utils/gameWallet.js";
import {
	getGameAccountByDiscordId,
	GameAccountConflictError,
	updateGameAccountPassword,
} from "../src/utils/gameAccount.js";
import { createAccountOAuthUrl } from "../src/utils/accountOAuth.js";

export const mini = new MiniInteraction();

function isAdministrator(interaction: CommandInteraction) {
	return (BigInt(interaction.member?.permissions ?? "0") & 8n) === 8n;
}

const INITIAL_PASSWORD_BUTTON_ID = "account:set-initial-password";
const INITIAL_PASSWORD_MODAL_ID = "account:initial-password-modal";
const RESET_PASSWORD_MODAL_ID = "account:reset-password-modal";
const PASSWORD_INPUT_ID = "account:password";
const PASSWORD_CONFIRM_INPUT_ID = "account:password-confirm";

function interactionDiscordId(interaction: {
	member?: { user?: { id?: string } } | null;
	user?: { id?: string } | null;
}): string {
	return String(interaction.member?.user?.id ?? interaction.user?.id ?? "").trim();
}

function passwordModal(customId: string, title: string) {
	return new ModalBuilder()
		.setCustomId(customId)
		.setTitle(title)
		.addComponents(
			new LabelBuilder()
				.setLabel("Yeni parola")
				.setDescription("Dungeon Blitz'e girişte kullanacağın 6-128 karakterlik parola.")
				.setComponent(
					new TextInputBuilder()
						.setCustomId(PASSWORD_INPUT_ID)
						.setStyle(TextInputStyle.Short)
						.setMinLength(6)
						.setMaxLength(128)
						.setRequired(true)
				),
			new LabelBuilder()
				.setLabel("Parolayı doğrula")
				.setComponent(
					new TextInputBuilder()
						.setCustomId(PASSWORD_CONFIRM_INPUT_ID)
						.setStyle(TextInputStyle.Short)
						.setMinLength(6)
						.setMaxLength(128)
						.setRequired(true)
				)
		);
}

async function handlePasswordModal(
	interaction: ModalSubmitInteraction,
	initialOnly: boolean
) {
	const discordId = interactionDiscordId(interaction);
	if (!discordId) {
		return interaction.reply({ content: "Discord hesabın doğrulanamadı.", flags: 64 });
	}
	const password = interaction.getTextFieldValue(PASSWORD_INPUT_ID) ?? "";
	const confirmation = interaction.getTextFieldValue(PASSWORD_CONFIRM_INPUT_ID) ?? "";
	if (password !== confirmation) {
		return interaction.reply({ content: "Parolalar eşleşmiyor.", flags: 64 });
	}

	interaction.deferReply({ flags: 64 });
	try {
		const result = await updateGameAccountPassword(discordId, password, { initialOnly });
		if (result.status === "not-found") {
			return interaction.editReply({
				content: "Önce `/create-account` komutundaki Discord OAuth bağlantısını tamamla.",
			});
		}
		if (result.status === "already-configured") {
			return interaction.editReply({
				content: "İlk parolan zaten ayarlanmış. Değiştirmek için `/account reset-password` kullan.",
			});
		}
		return interaction.editReply({
			content: initialOnly
				? `İlk parolan ayarlandı. Oyuna **${result.account.email}** adresiyle giriş yapabilirsin.`
				: `Parolan yenilendi. Oyuna **${result.account.email}** adresiyle giriş yapabilirsin.`,
		});
	} catch (error) {
		if (error instanceof GameAccountConflictError) {
			return interaction.editReply({ content: error.message });
		}
		console.error("[account] Password update failed:", error);
		return interaction.editReply({
			content: "Parola şu anda güncellenemedi. Lütfen daha sonra tekrar dene.",
		});
	}
}

function handleCreateAccountCommand(interaction: CommandInteraction) {
	const discordId = interactionDiscordId(interaction);
	if (!discordId) {
		return interaction.reply({ content: "Discord hesabın doğrulanamadı.", flags: 64 });
	}
	const oauthUrl = createAccountOAuthUrl(discordId);
	const row = new ActionRowBuilder<APIButtonComponent>().addComponents(
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel("Discord ile doğrula")
			.setURL(oauthUrl),
		new ButtonBuilder()
			.setStyle(ButtonStyle.Primary)
			.setLabel("İlk parolayı ayarla")
			.setCustomId(INITIAL_PASSWORD_BUTTON_ID)
	);
	return interaction.reply({
		content: [
			"Dungeon Blitz hesabını oluşturmak için önce Discord OAuth doğrulamasını tamamla.",
			"Hesap, Discord'daki **doğrulanmış e-posta adresinle** oluşturulacak.",
			"OAuth tamamlandıktan sonra bu mesaja dönüp **İlk parolayı ayarla** düğmesine bas.",
		].join("\n"),
		components: [row],
		flags: 64,
	});
}

mini.useCommand({
	data: new CommandBuilder()
		.setName("create-account")
		.setDescription("Doğrulanmış Discord e-postanla Dungeon Blitz hesabı oluştur"),
	handler: handleCreateAccountCommand,
});

mini.useCommand({
	data: new CommandBuilder()
		.setName("account")
		.setDescription("Dungeon Blitz hesabını yönet")
		.addSubcommand((subcommand) =>
			subcommand
				.setName("create")
				.setDescription("Doğrulanmış Discord e-postanla oyun hesabı oluştur")
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName("reset-password")
				.setDescription("Dungeon Blitz parolanı yenile")
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName("view")
				.setDescription("Bağlı Dungeon Blitz hesabını görüntüle")
		),
	handler: async (interaction: CommandInteraction) => {
		const discordId = interactionDiscordId(interaction);
		if (!discordId) {
			return interaction.reply({ content: "Discord hesabın doğrulanamadı.", flags: 64 });
		}
		const subcommand = interaction.options.getSubcommand(true);

		if (subcommand === "create") {
			return handleCreateAccountCommand(interaction);
		}

		if (subcommand === "reset-password") {
			return interaction.showModal(passwordModal(RESET_PASSWORD_MODAL_ID, "Dungeon Blitz parolasını yenile"));
		}

		interaction.deferReply({ flags: 64 });
		try {
			const account = await getGameAccountByDiscordId(discordId);
			if (!account) {
				return interaction.editReply({
					content: "Discord hesabına bağlı bir Dungeon Blitz hesabı yok. `/create-account` ile oluşturabilirsin.",
				});
			}
			return interaction.editReply({
				embeds: [{
					color: 0x5865f2,
					title: "Dungeon Blitz hesabın",
					fields: [
						{ name: "E-posta", value: account.email },
						{ name: "User ID", value: String(account.userId), inline: true },
						{
							name: "Parola",
							value: account.passwordConfigured ? "Ayarlı" : "İlk parola bekleniyor",
							inline: true,
						},
					],
				}],
			});
		} catch (error) {
			console.error("[account] Account view failed:", error);
			return interaction.editReply({
				content: "Hesap bilgileri şu anda yüklenemedi. Lütfen daha sonra tekrar dene.",
			});
		}
	},
});

mini.useComponent({
	customId: INITIAL_PASSWORD_BUTTON_ID,
	handler: (interaction: ButtonInteraction) =>
		interaction.showModal(passwordModal(INITIAL_PASSWORD_MODAL_ID, "İlk Dungeon Blitz parolan")),
});

mini.useModal({
	customId: INITIAL_PASSWORD_MODAL_ID,
	handler: (interaction: ModalSubmitInteraction) => handlePasswordModal(interaction, true),
});

mini.useModal({
	customId: RESET_PASSWORD_MODAL_ID,
	handler: (interaction: ModalSubmitInteraction) => handlePasswordModal(interaction, false),
});

mini.useCommand({
	data: new CommandBuilder()
		.setName("sponsor-info")
		.setDescription("Show a GitHub sponsor's sponsorship information")
		.setDefaultMemberPermissions(8n)
		.setDMPermission(false)
		.addStringOption((option) =>
			option
				.setName("github_username")
				.setDescription("The sponsor's GitHub username")
				.setRequired(true)
		),
	handler: async (interaction: CommandInteraction) => {
		if (!isAdministrator(interaction)) {
			return interaction.reply({ content: "Administrator permission is required.", flags: 64 });
		}
		const githubUsername = interaction.options.getString("github_username", true)!;
		interaction.deferReply({ flags: 64 });

		try {
			const sponsorship = await getSponsorDonationInfo(githubUsername);
			if (!sponsorship) {
				return interaction.editReply({
					content: `No GitHub sponsorship information was found for **${githubUsername}**.`,
				});
			}

			const amount = sponsorship.amountInCents === null
				? "Not visible"
				: `$${(sponsorship.amountInCents / 100).toFixed(2)} USD${
						sponsorship.isOneTimePayment ? " one-time" : " per month"
				  }`;
			const startedAt = Math.floor(new Date(sponsorship.createdAt).getTime() / 1000);
			const estimatedTotal = sponsorship.estimatedTotalInCents === null
				? "Not visible"
				: `$${(sponsorship.estimatedTotalInCents / 100).toFixed(2)} USD`;
			const totalLabel = sponsorship.totalEstimateScope === "current-tier"
				? "Estimated total (current tier only)"
				: sponsorship.totalEstimateScope === "one-time"
					? "Total donation"
					: "Estimated total";

			return interaction.editReply({
				embeds: [{
					color: sponsorship.isActive ? 0x2da44e : 0x6e7781,
					title: `${sponsorship.githubUsername}'s sponsorship`,
					url: `https://github.com/${encodeURIComponent(sponsorship.githubUsername)}`,
					fields: [
						{ name: "Sponsored account", value: sponsorship.targetLogin, inline: true },
						{ name: "Status", value: sponsorship.isActive ? "Active" : "Past sponsor", inline: true },
						{ name: "Amount", value: amount, inline: true },
						{ name: totalLabel, value: estimatedTotal, inline: true },
						{ name: "Tier", value: sponsorship.tierName ?? "Not visible", inline: true },
						{ name: "Started", value: `<t:${startedAt}:D>`, inline: true },
					],
					footer: { text: "Recurring totals are estimates from the visible tier and dates; GitHub does not expose a payment ledger." },
				}],
			});
		} catch (error) {
			console.error("[sponsor-info] Failed to load sponsorship information:", error);
			return interaction.editReply({
				content: "I couldn't load that sponsor's information from GitHub right now.",
			});
		}
	},
});

mini.useCommand({
	data: new CommandBuilder()
		.setName("idols")
		.setDescription("Manually add or subtract a player's Mammoth Idols")
		.setDefaultMemberPermissions(8n)
		.setDMPermission(false)
		.addStringOption((option) =>
			option
				.setName("player")
				.setDescription("Search by character name or game user ID")
				.setAutocomplete(true)
				.setRequired(true)
		)
		.addStringOption((option) =>
			option
				.setName("operation")
				.setDescription("Whether to add or subtract idols")
				.addChoices(
					{ name: "Add", value: "add" },
					{ name: "Subtract", value: "sub" }
				)
				.setRequired(true)
		)
		.addNumberOption((option) =>
			option
				.setName("amount")
				.setDescription("Positive whole number of idols")
				.setMinValue(1)
				.setRequired(true)
		),
	handler: async (interaction: CommandInteraction) => {
		if (!isAdministrator(interaction)) {
			return interaction.reply({ content: "Administrator permission is required.", flags: 64 });
		}

		const walletId = interaction.options.getString("player", true)!;
		const operation = interaction.options.getString("operation", true);
		const amount = interaction.options.getNumber("amount", true)!;
		if ((operation !== "add" && operation !== "sub") || !Number.isSafeInteger(amount) || amount <= 0) {
			return interaction.reply({ content: "Choose add/sub and enter a positive whole number.", flags: 64 });
		}

		try {
			console.info("[idols] Applying wallet adjustment", {
				selector: walletId,
				operation,
				amount,
			});
			const result = await adjustMammothIdols(walletId, operation, amount);
			if (!result) {
				return interaction.reply({
					content: operation === "sub"
						? "Player not found or the player does not have enough Mammoth Idols."
						: "Player wallet not found.",
					flags: 64,
				});
			}

			return interaction.reply({
				content: `**${result.after.characterName}**: Mammoth Idols ${result.before.mammothIdols.toLocaleString()} → **${result.after.mammothIdols.toLocaleString()}** (${operation === "add" ? "+" : "−"}${amount.toLocaleString()})`,
				flags: 64,
			});
		} catch (error) {
			console.error("[idols] Wallet update failed:", error);
			return interaction.reply({ content: "The player wallet could not be updated.", flags: 64 });
		}
	},
});

mini.useCommand({
	data: new CommandBuilder()
		.setName("profile")
		.setDescription("Show a player's linked profile and current game wallet data")
		.setDefaultMemberPermissions(8n)
		.setDMPermission(false)
		.addStringOption((option) =>
			option
				.setName("player")
				.setDescription("Search GitHub, Discord, character name, or game user ID")
				.setAutocomplete(true)
				.setRequired(true)
		),
	handler: async (interaction: CommandInteraction) => {
		if (!isAdministrator(interaction)) {
			return interaction.reply({ content: "Administrator permission is required.", flags: 64 });
		}
		interaction.deferReply({ flags: 64 });
		const selector = interaction.options.getString("player", true)!;

		try {
			const profile = await getPlayerProfile(selector);
			if (!profile) return interaction.editReply({ content: "Player profile was not found." });
			const fields: Array<{ name: string; value: string; inline?: boolean }> = [
				{ name: "GitHub", value: profile.githubUsername ?? "Not linked", inline: true },
				{ name: "Discord ID", value: profile.discordUserId ?? "Not linked", inline: true },
				{ name: "Sponsor", value: profile.isSponsor === null ? "Unknown" : profile.isSponsor ? `Yes (${profile.sponsorTarget ?? "unknown target"})` : "No", inline: true },
				{ name: "Contributor", value: profile.isContributor === null ? "Unknown" : profile.isContributor ? "Yes" : "No", inline: true },
			];

			for (const wallet of profile.wallets.slice(0, 5)) {
				fields.push({
					name: `${wallet.characterName} [${wallet.gameUserId}]`,
					value: [
						`Gold: **${wallet.gold.toLocaleString()}**`,
						`Mammoth Idols: **${wallet.mammothIdols.toLocaleString()}**`,
						`Dragon Keys: **${wallet.dragonKeys.toLocaleString()}**`,
						`Dragon Ore: **${wallet.dragonOre.toLocaleString()}**`,
						`Silver/Royal Sigils: **${wallet.silverSigils.toLocaleString()} / ${wallet.royalSigils.toLocaleString()}**`,
					].join("\n"),
				});
			}
			if (profile.wallets.length === 0) {
				fields.push({ name: "Game wallets", value: "No matching wallet document exists yet." });
			}

			return interaction.editReply({
				embeds: [{
					color: 0x5865f2,
					title: profile.githubUsername ?? profile.wallets[0]?.characterName ?? "Player profile",
					fields,
				}],
			});
		} catch (error) {
			console.error("[profile] Failed to load player profile:", error);
			return interaction.editReply({ content: "The player profile could not be loaded." });
		}
	},
});

async function handleAutocomplete(body: any) {
	if (body?.type !== 4 || !["idols", "profile"].includes(body?.data?.name)) return null;
	const focused = Array.isArray(body.data.options)
		? body.data.options.find((option: any) => option?.focused)
		: null;
	if (focused?.name !== "player") return { type: 8, data: { choices: [] } };

	try {
		const query = String(focused.value ?? "");
		const choices = body.data.name === "profile"
			? (await searchPlayers(query)).map((player) => ({
					name: player.label.slice(0, 100),
					value: player.selector,
			  }))
			: (await searchGameWallets(query)).map((wallet) => ({
					name: `${wallet.characterName} [${wallet.gameUserId}] • Idols ${wallet.mammothIdols} • Gold ${wallet.gold} • Keys ${wallet.dragonKeys}`.slice(0, 100),
					value: wallet.selector,
			  }));
		return {
			type: 8,
			data: {
				choices,
			},
		};
	} catch (error) {
		console.error("[idols] Autocomplete failed:", error);
		return { type: 8, data: { choices: [] } };
	}
}

export default async function handler(request: any, response: any) {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const rawBody = Buffer.concat(chunks);
	const signature = String(request.headers["x-signature-ed25519"] ?? "");
	const timestamp = String(request.headers["x-signature-timestamp"] ?? "");

	if (!signature || !timestamp || !verifyKey(rawBody, signature, timestamp, mini.publicKey)) {
		return response.status(401).json({ error: "Invalid Discord interaction signature" });
	}

	let body: any;
	try {
		body = JSON.parse(rawBody.toString("utf8"));
	} catch {
		return response.status(400).json({ error: "Invalid interaction payload" });
	}

	const autocomplete = await handleAutocomplete(body);
	if (autocomplete) return response.status(200).json(autocomplete);

	const result = await mini.handleRequest({ body: rawBody, signature, timestamp });
	if (result.backgroundWork) {
		try {
			const { waitUntil } = await import("@vercel/functions");
			waitUntil(result.backgroundWork);
		} catch (error) {
			console.error("[interactions] Background work scheduling failed:", error);
		}
	}
	return response.status(result.status).json(result.body);
}
