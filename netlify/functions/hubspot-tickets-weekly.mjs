// Scheduled function: Every Friday 10AM MYT (02:00 UTC)
// Pulls Jira B2 release from Thursday, extracts HubSpot links, posts to Slack

import { getStore } from "@netlify/blobs";

export const config = {
  schedule: "0 2 * * 5" // Friday 10AM MYT (UTC+8 = 02:00 UTC)
};

const JIRA_CLOUD_ID = "e38dd556-d5ba-4444-8e93-93420ba8123c";

export default async () => {
  try {
    const releaseDate = getThursdayMYT(); // Releases are dated Thursday; we run Friday morning
    console.log(`[hubspot-tickets] Looking for release on: ${releaseDate}`);

    // Step 1: Find Thursday's release version
    const version = await findReleaseForDate(releaseDate);
    if (!version) {
      console.log("[hubspot-tickets] No qualifying release found. Skipping.");
      return new Response("No release found", { status: 200 });
    }
    console.log(`[hubspot-tickets] Found release: ${version.name}`);

    // Step 2: Dedup guard — skip if already sent for this release
    const store = getStore("hubspot-dedup");
    const lastSent = await store.get("last-sent-release").catch(() => null);
    if (lastSent === version.name) {
      console.log(`[hubspot-tickets] Already sent for ${version.name}. Skipping.`);
      return new Response("Already sent", { status: 200 });
    }

    // Step 3: Get qualifying tickets (Story, Task, Hotfix, Off Cycle)
    const issues = await getIssuesForVersion(version.name);
    console.log(`[hubspot-tickets] Found ${issues.length} qualifying tickets`);

    // Step 4: Extract HubSpot links with ticket titles from descriptions
    const hubspotEntries = extractHubspotLinks(issues);
    console.log(`[hubspot-tickets] Found ${hubspotEntries.length} HubSpot links`);

    // Step 5: Send to Slack
    await sendToSlack(hubspotEntries);
    console.log("[hubspot-tickets] Message sent to Slack");

    // Step 6: Record sent release to prevent duplicates
    await store.set("last-sent-release", version.name);

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[hubspot-tickets] Error:", err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

// Returns the date of the most recent Thursday in MYT (YYYY-MM-DD)
// Releases are scheduled on Thursdays; this function runs Friday 10AM MYT
function getThursdayMYT() {
  const now = new Date();
  const myt = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  myt.setDate(myt.getDate() - 1); // Yesterday = Thursday
  const y = myt.getFullYear();
  const m = String(myt.getMonth() + 1).padStart(2, "0");
  const d = String(myt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function jiraFetch(path) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const auth = Buffer.from(`${email}:${token}`).toString("base64");

  const res = await fetch(
    `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json"
      }
    }
  );

  if (!res.ok) {
    throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function jiraPost(path, body) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const auth = Buffer.from(`${email}:${token}`).toString("base64");

  const res = await fetch(
    `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) {
    throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function findReleaseForDate(date) {
  const unreleased = await jiraFetch("/project/B2/version?status=unreleased&orderBy=-sequence&maxResults=50");
  for (const v of (unreleased.values || unreleased)) {
    if (v.releaseDate !== date) continue;
    if (/mobile|rn mobile|special/i.test(v.name)) continue;
    if (!/^\d+\.\d+\.0$/.test(v.name)) continue;
    return v;
  }

  // Also check already-released versions
  const released = await jiraFetch("/project/B2/version?status=released&orderBy=-sequence&maxResults=20");
  for (const v of (released.values || released)) {
    if (v.releaseDate !== date) continue;
    if (/mobile|rn mobile|special/i.test(v.name)) continue;
    if (!/^\d+\.\d+\.0$/.test(v.name)) continue;
    return v;
  }

  return null;
}

async function getIssuesForVersion(versionName) {
  const data = await jiraPost("/search/jql", {
    jql: `project = B2 AND fixVersion = "${versionName}" AND issuetype in (Story, Task, Hotfix, "Off Cycle")`,
    fields: ["summary", "description", "issuetype"],
    maxResults: 100
  });
  return data.issues || [];
}

function extractHubspotLinks(issues) {
  const seen = new Set();
  const entries = [];
  const hubspotRegex = /https?:\/\/app\.hubspot\.com\/contacts\/[^\s"<>\]|)]*/gi;

  for (const issue of issues) {
    const desc = issue.fields?.description;
    const title = issue.fields?.summary || "";
    if (!desc) continue;

    const text = typeof desc === "string" ? desc : JSON.stringify(desc);
    const matches = text.match(hubspotRegex);
    if (matches) {
      for (const url of matches) {
        const clean = url.replace(/[,;.]+$/, "");
        if (!seen.has(clean)) {
          seen.add(clean);
          entries.push({ title, url: clean });
        }
      }
    }
  }

  return entries;
}

async function sendToSlack(hubspotEntries) {
  const webhookUrl = process.env.SLACK_HUBSPOT_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("Missing SLACK_HUBSPOT_WEBHOOK_URL env var");
  }

  let linksList;
  if (hubspotEntries.length === 0) {
    linksList = "No HubSpot tickets found in this release.";
  } else {
    linksList = hubspotEntries.map((entry, i) => `${i + 1}. ${entry.title}\n    ${entry.url}`).join("\n");
  }

  const message = `Hey <!subteam^S04S66530SX>, PM Pic of this week release. Please update all the hubspot ticket status to "Tech Status = Deployed" and move it back to "Re-engage Client/Support Team Clarification". Here's the list of the hubspot ticket\n\n${linksList}`;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message })
  });

  if (!res.ok) {
    throw new Error(`Slack webhook error ${res.status}: ${await res.text()}`);
  }
}
