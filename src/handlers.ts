import {
	LogService,
	type MatrixClient,
	UserID,
	type MatrixEvent,
} from "matrix-bot-sdk";
import {
	CHATGPT_CONTEXT,
	CHATGPT_TIMEOUT,
	CHATGPT_IGNORE_MEDIA,
	MATRIX_DEFAULT_PREFIX_REPLY,
	MATRIX_DEFAULT_PREFIX,
	MATRIX_BLACKLIST,
	MATRIX_WHITELIST,
	MATRIX_RICH_TEXT,
	MATRIX_PREFIX_DM,
	MATRIX_THREADS,
	MATRIX_ROOM_BLACKLIST,
	MATRIX_ROOM_WHITELIST,
	MATRIX_WELCOME,
	MATRIX_AUTOJOIN,
} from "./env.js";
import type {
	RelatesTo,
	MessageEvent,
	StoredConversation,
	StoredConversationConfig,
} from "./interfaces.js";
import {
	getIntroMessage,
	sendChatGPTMessage,
	sendError,
	sendReply,
	setBotAvatar,
} from "./utils.js";
import type OpenAI from "openai";
import MonitorActivities from "./monitorActivities.js";
import { type IdentityResponse, getGidIdentity } from "./user.js";

export default class CommandHandler {
	// Variables so we can cache the bot's display name and ID for command matching later.
	private displayName: string;
	private userId: string;
	private localpart: string;
	private monitorActivities: MonitorActivities;

	constructor(
		private client: MatrixClient,
		private openai: OpenAI,
		private assistantId: string,
	) {}

	public async start() {
		await this.prepareProfile(); // Populate the variables above (async)
		// prepare monitoring activites with unique id for the user and uns name
		this.monitorActivities = new MonitorActivities();
		this.client.on("room.message", this.onMessage.bind(this)); // Set up the event handler

		this.client.on("room.failed_decryption", async (roomId, event, error) => {
			// handle `m.room.encrypted` event that could not be decrypted
			LogService.error(
				"index",
				`Failed decryption event!\n${{ roomId, event, error }}`,
			);
			await this.client.sendText(
				roomId,
				"Something went wrong please try again.",
			);
		});

		this.client.on("room.join", async (roomId: string, _event: MatrixEvent) => {
			LogService.info("index", `Bot joined room ${roomId}`);
			if (MATRIX_WELCOME) {
				await this.client.sendMessage(roomId, getIntroMessage());
			}
		});
		if (MATRIX_AUTOJOIN) {
			this.client.on(
				"room.invite",
				async (roomId: string, inviteEvent: MatrixEvent) => {
					try {
						await this.client.joinRoom(roomId);
					} catch (e) {
						LogService.error("index", "Error joining room", e);
					}
				},
			);
		}
	}

	private async prepareProfile() {
		this.userId = await this.client.getUserId();
		this.localpart = new UserID(this.userId).localpart;
		LogService.info(
			"CommandHandler",
			`Starting command handler for ${this.userId}`,
		);
		try {
			const profile = await this.client.getUserProfile(this.userId);
			if (profile?.displayname) this.displayName = profile.displayname;
			if (!profile?.avatar_url) {
				setBotAvatar(this.client);
			}
		} catch (e) {
			LogService.warn("CommandHandler", e); // Non-fatal error - we'll just log it and move on.
		}
	}

	private shouldIgnore(event: MessageEvent, roomId: string): boolean {
		if (event.sender === this.userId) return true; // Ignore ourselves
		if (MATRIX_BLACKLIST?.split(" ").find((b) => event.sender.endsWith(b)))
			return true; // Ignore if on blacklist if set
		if (
			MATRIX_WHITELIST &&
			!MATRIX_WHITELIST.split(" ").find((w) => event.sender.endsWith(w))
		)
			return true; // Ignore if not on whitelist if set
		if (MATRIX_ROOM_BLACKLIST?.split(" ").find((b) => roomId.endsWith(b)))
			return true; // Ignore if on room blacklist if set
		if (
			MATRIX_ROOM_WHITELIST &&
			!MATRIX_ROOM_WHITELIST.split(" ").find((w) => roomId.endsWith(w))
		)
			return true; // Ignore if not on room whitelist if set
		if (Date.now() - event.origin_server_ts > 10000) return true; // Ignore old messages
		if (event.content["m.relates_to"]?.rel_type === "m.replace") return true; // Ignore edits
		if (CHATGPT_IGNORE_MEDIA && event.content.msgtype !== "m.text") return true; // Ignore everything which is not text if set
		return false;
	}

	private getRootEventId(event: MessageEvent): string {
		const relatesTo: RelatesTo | undefined = event.content["m.relates_to"];
		const isReplyOrThread: boolean = relatesTo === undefined;
		return !isReplyOrThread && relatesTo.event_id !== undefined
			? relatesTo.event_id
			: event.event_id;
	}

	private getStorageKey(event: MessageEvent, roomId: string): string {
		const rootEventId: string = this.getRootEventId(event);
		if (CHATGPT_CONTEXT === "room") {
			return roomId;
		}
		if (CHATGPT_CONTEXT === "thread") {
			return rootEventId;
		}
		// CHATGPT_CONTEXT set to both.
		return rootEventId !== event.event_id ? rootEventId : roomId;
	}

	private async getStoredConversation(
		storageKey: string,
		roomId: string,
	): Promise<StoredConversation> {
		let storedValue: string = await this.client.storageProvider.readValue(
			`gpt-${storageKey}`,
		);
		if (storedValue === undefined && storageKey !== roomId)
			storedValue = await this.client.storageProvider.readValue(
				`gpt-${roomId}`,
			);
		return storedValue !== undefined ? JSON.parse(storedValue) : undefined;
	}

	private getConfig(
		storedConversation: StoredConversation,
	): StoredConversationConfig {
		return storedConversation !== undefined &&
			storedConversation.config !== undefined
			? storedConversation.config
			: {};
	}

	private async shouldBePrefixed(
		config: StoredConversationConfig,
		roomId: string,
		event: MessageEvent,
	): Promise<boolean> {
		const relatesTo: RelatesTo | undefined = event.content["m.relates_to"];
		const isReplyOrThread: boolean = relatesTo === undefined;
		const isDm: boolean = this.client.dms.isDm(roomId);
		const MATRIX_PREFIX: string =
			config.MATRIX_PREFIX === undefined
				? MATRIX_DEFAULT_PREFIX
				: config.MATRIX_PREFIX;
		const MATRIX_PREFIX_REPLY: boolean =
			config.MATRIX_PREFIX_REPLY === undefined
				? MATRIX_DEFAULT_PREFIX_REPLY
				: config.MATRIX_PREFIX_REPLY;
		let shouldBePrefixed: boolean =
			(MATRIX_PREFIX && isReplyOrThread) ||
			(MATRIX_PREFIX_REPLY && !isReplyOrThread);
		if (!MATRIX_PREFIX_DM && isDm) shouldBePrefixed = false;
		const prefixes = [
			MATRIX_PREFIX,
			`${this.localpart}:`,
			`${this.displayName}:`,
			`${this.userId}:`,
		];
		if (!isReplyOrThread && !MATRIX_PREFIX_REPLY) {
			if (relatesTo.event_id !== undefined) {
				const rootEvent: MessageEvent = await this.client.getEvent(
					roomId,
					relatesTo.event_id,
				); // relatesTo is root event.
				const rootPrefixUsed = prefixes.find((p) =>
					rootEvent.content.body.startsWith(p),
				);
				if (MATRIX_PREFIX && !rootPrefixUsed && !(!MATRIX_PREFIX_DM && isDm))
					return false; // Ignore unrelated threads or certain dms
			} else {
				// reply not thread, iterating for a prefix not implemented
				return false; // Ignore if no relatesTo EventID
			}
		}
		const prefixUsed: string = prefixes.find((p) =>
			event.content.body.startsWith(p),
		);
		if (shouldBePrefixed && !prefixUsed) return false; // Ignore without prefix if prefixed
		return true;
	}

	private async getBodyWithoutPrefix(
		event: MessageEvent,
		config: StoredConversationConfig,
		shouldBePrefixed: boolean,
	): Promise<string> {
		const MATRIX_PREFIX: string =
			config.MATRIX_PREFIX === undefined
				? MATRIX_DEFAULT_PREFIX
				: config.MATRIX_PREFIX;
		const prefixUsed: string = [
			MATRIX_PREFIX,
			`${this.localpart}:`,
			`${this.displayName}:`,
			`${this.userId}:`,
		].find((p) => event.content.body.startsWith(p));
		const trimLength = shouldBePrefixed && prefixUsed ? prefixUsed.length : 0;
		return event.content.body.slice(trimLength).trimStart();
	}

	/**
	 * Run when `message` room event is received. The bot only sends a message if needed.
	 * @returns Room event handler, which itself returns nothing
	 */
	private async onMessage(roomId: string, event: MessageEvent) {
		try {
			if (this.shouldIgnore(event, roomId)) return;
			const localpartSender = new UserID(event.sender).localpart;
			const user: IdentityResponse = await getGidIdentity(localpartSender);
			const storageKey = this.getStorageKey(event, roomId);
			const storedConversation = await this.getStoredConversation(
				storageKey,
				roomId,
			);

			const config = this.getConfig(storedConversation);

			const shouldBePrefixed = await this.shouldBePrefixed(
				config,
				roomId,
				event,
			);
			if (!shouldBePrefixed) return;
			// send tracking when user send new message
			this.monitorActivities.trackSendMessageEvent(
				event.content.body,
				user.gid_uuid,
				user.name,
			);

			await Promise.all([
				this.client.sendReadReceipt(roomId, event.event_id),
				this.client.setTyping(roomId, true, CHATGPT_TIMEOUT),
			]);

			const bodyWithoutPrefix = await this.getBodyWithoutPrefix(
				event,
				config,
				shouldBePrefixed,
			);
			if (!bodyWithoutPrefix) {
				await sendError(
					this.client,
					`Error with body: ${event.content.body}`,
					roomId,
					event.event_id,
				);
				return;
			}
			const meta = { gidUuid: user.gid_uuid, name: user.name };

			const result = await sendChatGPTMessage(
				this.openai,
				this.assistantId,
				bodyWithoutPrefix,
				storedConversation,
				meta
			);

			const response =
				result.message.type === "text"
					? result.message.text.value
					: "Message content not supported.";

			await Promise.all([
				this.client.setTyping(roomId, false, 500),
				sendReply(
					this.client,
					roomId,
					this.getRootEventId(event),
					`${response}`,
					MATRIX_THREADS,
					MATRIX_RICH_TEXT,
				),
			]);

			const storedConfig =
				storedConversation !== undefined &&
				storedConversation.config !== undefined
					? storedConversation.config
					: {};
			const configString: string = JSON.stringify({
				threadId: result.threadId,
				config: storedConfig,
			});
			await this.client.storageProvider.storeValue(
				`gpt-${storageKey}`,
				configString,
			);
			if (storageKey === roomId && CHATGPT_CONTEXT === "both")
				await this.client.storageProvider.storeValue(
					`gpt-${event.event_id}`,
					configString,
				);
		} catch (err) {
			LogService.error(`OpenAI-API Error: ${err}`);
			sendError(
				this.client,
				`The bot has encountered an error, please contact your administrator (Error code ${
					err.status || "Unknown"
				}).`,
				roomId,
				event.event_id,
			);
		}
	}
}
