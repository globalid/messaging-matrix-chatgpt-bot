import { fetch } from "undici";
import { BOT_DEVICE_ID, KEYV_BOT_STORAGE } from "./env.js";
import { KeyvStorageProvider } from "./storage.js";
import { LogService } from "matrix-bot-sdk";
import { API_URL } from "./env.js";

export interface IdentityResponse {
	gid_uuid: string;
	name: string;
	display_name: string;
	profile_photo: string;
	created_at: string;
	public_key: string;
	country_code: string;
	type: string;
}

let storage = null;
const base_url = `${API_URL}/v1`;

/**
 * Retrieves user details from the GlobalID API or cache based on the provided GlobalID UUID.
 * @param gid_uuid - The GlobalID UUID of the user.
 * @returns A promise that resolves to the user details.
 */
export async function getGidIdentity(gid_uuid: string) {
  try {
    if (KEYV_BOT_STORAGE) {
      storage = new KeyvStorageProvider(BOT_DEVICE_ID, "chatgpt-user-storage");
    }

    const cachedUser = await storage.readValue(`user-${gid_uuid}`);
    if (cachedUser !== undefined) {
      return JSON.parse(cachedUser) as IdentityResponse;
    }

    // Fetch from API if not in cache
    const response = await fetch(`${base_url}/directory/${gid_uuid}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const userData = await response.json();

    // Store in cache
    await storage.storeValue(
      `user-${gid_uuid}`,
      JSON.stringify(userData)
    );

    // Return the parsed data
    return userData as IdentityResponse;
  } catch (err) {
    LogService.error(`OpenAI-API Error: ${err}`);
    return Promise.reject(err);
  }
}
