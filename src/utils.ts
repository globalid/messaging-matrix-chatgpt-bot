import Markdown from "markdown-it";
import { LogService, type MatrixClient } from "matrix-bot-sdk";
import type { MessageEvent, StoredConversation } from "./interfaces.js";
import { CHATGPT_TIMEOUT, BOT_LOGO_URL } from "./env.js";
import type OpenAI from "openai";
import type { MessageContent } from "openai/resources/beta/threads/messages.js";
import introMessage from "./introMessage.json" with { "type": "json" };

const md = Markdown();

export function parseMatrixUsernamePretty(matrix_username: string): string {
	if (
		matrix_username.includes(":") === false ||
		matrix_username.includes("@") === false
	) {
		return matrix_username;
	}
	const withoutUrl = matrix_username.split(":")[0];
	return withoutUrl.split("@")[1];
}

export function isEventAMessage(event: unknown): event is MessageEvent {
	return (
		typeof event === "object" &&
		!event &&
		"type" in event &&
		event.type === "m.room.message"
	);
}

export async function sendError(
	client: MatrixClient,
	text: string,
	roomId: string,
	eventId: string,
): Promise<void> {
	Promise.all([
		client.setTyping(roomId, false, 500),
		client.sendText(roomId, text),
		client.sendReadReceipt(roomId, eventId),
	]);
}

/**
 * Send a thread reply.
 * @param {MatrixClient} client Matrix client
 * @param {string} roomId the room ID the event being replied to resides in
 * @param {string} rootEventId the root event of the thread
 * @param {string} text the plain text to reply with
 * @param {boolean} thread reply as a thread
 * @param {boolean} rich should the plain text be rendered to html using markdown?
 */
export async function sendReply(
	client: MatrixClient,
	roomId: string,
	rootEventId: string,
	text: string,
	thread = false,
	rich = false,
): Promise<void> {
	const contentCommon = {
		body: text,
		msgtype: "m.text",
	};

	const contentThreadOnly = {
		"m.relates_to": {
			event_id: rootEventId,
			is_falling_back: true,
			"m.in_reply_to": {
				event_id: rootEventId,
			},
			rel_type: "m.thread",
		},
	};

	const contentTextOnly = {
		"org.matrix.msc1767.text": text,
	};

	const renderedText = md.render(text);

	const contentRichOnly = {
		format: "org.matrix.custom.html",
		formatted_body: renderedText,
		"org.matrix.msc1767.message": [
			{
				body: text,
				mimetype: "text/plain",
			},
			{
				body: renderedText,
				mimetype: "text/html",
			},
		],
	};

	const content = rich
		? { ...contentCommon, ...contentRichOnly }
		: { ...contentCommon, ...contentTextOnly };
	const finalContent = thread ? { ...content, ...contentThreadOnly } : content;

	await client.sendEvent(roomId, "m.room.message", finalContent);
}

export async function sendChatGPTMessage(
	openai: OpenAI,
	assistantId: string,
	question: string,
	storedConversation: StoredConversation | undefined,
) {
	let threadId: string | null = null;
	if (!storedConversation) {
		const thread = await createThread(openai);
		threadId = thread.id;
	} else {
		threadId = storedConversation.threadId;
	}

	await addMessage(openai, threadId, question);

	const run = await runAssistant(openai, assistantId, threadId);

	const runId = run.id;

	const message = await checkingStatus(openai, threadId, runId);
	return { message, threadId };
}

export async function createThread(openai: OpenAI) {
	LogService.debug("utils", "Creating a new thread...");
	const thread = await openai.beta.threads.create();
	return thread;
}

export function wrapPrompt(wrapped: string) {
	const currentDateString = new Date().toLocaleDateString("en-us", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
	return `<|im_sep|>${wrapped}\nCurrent date: ${currentDateString}<|im_sep|>\n\n`;
}

export async function addMessage(
	openai: OpenAI,
	threadId: string,
	message: string,
) {
	LogService.debug("utils", `Adding a new message to thread: ${threadId}`);
	const response = await openai.beta.threads.messages.create(threadId, {
		role: "user",
		content: message,
	});
	return response;
}

export async function runAssistant(
	openai: OpenAI,
	assistantId: string,
	threadId: string,
) {
	LogService.debug("utils", `Running assistant for thread: ${threadId}`);
	const response = await openai.beta.threads.runs.create(threadId, {
		assistant_id: assistantId,
	});

	return response;
}

export async function checkingStatus(
	openai: OpenAI,
	threadId: string,
	runId: string,
) {
	LogService.info("utils", `Starting status polling for run: ${runId}`);

	return new Promise<MessageContent>((resolve, reject) => {
		const start = Date.now();

		const pollingInterval = setInterval(async () => {
			if (Date.now() - start > CHATGPT_TIMEOUT) {
				LogService.error(`Polling timed out after ${Math.round((Date.now() - start) / 1000)}s for run: ${runId}`);
				clearInterval(pollingInterval);
				return reject(new Error("Response timed out"));
			}

			try {
				const runObject = await openai.beta.threads.runs.retrieve(
					threadId,
					runId,
				);
				const status = runObject.status;

				if (status === "completed") {
					LogService.info("utils", `Run ${runId} completed successfully`);
					clearInterval(pollingInterval);

					try {
						const messagesList = await openai.beta.threads.messages.list(threadId);

						if (messagesList.data.length > 0 && messagesList.data[0].content.length > 0) {
							const content = messagesList.data[0].content[0];
							resolve(content);
						} else {
							LogService.error("utils", `No message content available for run: ${runId}`);
							reject(new Error("No message content available"));
						}
					} catch (messageError) {
						LogService.error("utils", `Error fetching messages: ${messageError}`);
						reject(messageError);
					}
				} else if (status === "failed" || status === "cancelled" || status === "expired") {
					LogService.error("utils", `Run ${runId} ended with status: ${status}`);
					clearInterval(pollingInterval);
					reject(new Error(`Run ended with status: ${status}`));
				}

			} catch (error) {
				LogService.error("utils", `Error checking run status for ${runId}: ${error}`);
				clearInterval(pollingInterval);
				reject(error);
			}
		}, 1000);
	});
}

export function getIntroMessage() {
	return introMessage;
}

export async function setBotAvatar(client: MatrixClient) {
	const avatarMxUrl = await client.uploadContentFromUrl(BOT_LOGO_URL);
	return client.setAvatarUrl(avatarMxUrl);
}
