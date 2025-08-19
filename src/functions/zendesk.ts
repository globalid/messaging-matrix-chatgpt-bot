import fetch from "node-fetch";

const {
  ZENDESK_SUBDOMAIN,
  ZENDESK_EMAIL,
  ZENDESK_API_TOKEN,
} = process.env;

export async function createZendeskTicket(args) {
  const { name, email, subject, priority, comment, type } = args;
  const auth = Buffer
    .from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`)
    .toString("base64");

  const body = {
    ticket: {
      subject,
      priority,
      type,
      requester: { name, email },
      comment: { body: comment },
    },
  };

  const res = await fetch(`https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zendesk create ticket failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  return JSON.stringify({
    ticketId: json?.ticket?.id,
    status: json?.ticket?.status,
    url: json?.ticket?.url,
  });
}

