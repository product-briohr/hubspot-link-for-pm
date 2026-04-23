// Scheduled function: Every Thursday 3pm MYT (7am UTC)
// Pulls Jira B2 release for this week, extracts HubSpot links, posts to Slack #professional-overthinkers

export const config = {
  schedule: "0 7 * * 4" // 3PM MYT (UTC+8) every Thursday
};

const JIRA_CLOUD_ID = "e38dd556-d5ba-4444-8e93-93420ba8123c";

export default async () => {
  try {
    const today = getTodayMYT(); // YYYY-MM-DD in MYT timezone
    console.log(`[hubspot-tickets] Running for date: ${today}`);

    // Step 1: Find the release version with today's date
    const version = await findTodayRelease(today);
    if (!version) {
      console.log("[hubspot-tickets] No qualifying release found for today. Skipping.");
      return new Response("No release found", { status: 200 });
    }
    console.log(`[hubspot-tickets] Found release: ${version.name}`);

    // Step 2: Get qualifying tickets (Story, Task, Hotfix, Off Cycle)
    const issues = await getIssuesForVersion(version.name);
    console.log(`[hubspot-tickets] Found ${issues.length} qualifying tickets`);

    // Step 3: Extract HubSpot links from descriptions
    const hubspotLinks = extractHubspotLinks(issues);
    console.log(`[hubspot-tickets] Found ${hubspotLinks.length} HubSpot links`);

    // Step 4: Send to Slack
    await sendToSlack(hubspotLinks);
    console.log("[hubspot-tickets] Message sent to Slack");

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("[hubspot-tickets] Error:", err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

function getTodayMYT() {
  const now = new Date();
  const myt = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
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

async function findTodayRelease(today) {
  const versions = await jiraFetch("/project/B2/version?status=unreleased&orderBy=-sequence&maxResults=50");
  const versionList = versions.values || versions;

  for (const v of versionList) {
    if (v.releaseDate !== today) continue;
    if (/mobile|rn mobile|special/i.test(v.name)) continue;
    if (!/^\d+\.\d+\.0$/.test(v.name)) continue;
    return v;
  }

  // Also check released versions in case it was already released today
  const released = await jiraFetch("/project/B2/version?status=released&orderBy=-sequence&maxResults=20");
  const releasedList = released.values || released;

  for (const v of releasedList) {
    if (v.releaseDate !== today) continue;
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
  const links = new Set();
  const hubspotRegex = /https?:\/\/[^\s"<>\]|)]*hubspot\.com[^\s"<>\]|)]*/gi;

  for (const issue of issues) {
    const desc = issue.fields?.description;
    if (!desc) continue;

    // Description can be ADF (object) or rendered text
    const text = typeof desc === "string" ? desc : JSON.stringify(desc);
    const matches = text.match(hubspotRegex);
    if (matches) {
      for (const url of matches) {
        // Clean trailing punctuation
        const clean = url.replace(/[,;.]+$/, "");
        links.add(clean);
      }
    }
  }

  return [...links];
}

async function sendToSlack(hubspotLinks) {
  const webhookUrl = process.env.SLACK_HUBSPOT_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("Missing SLACK_HUBSPOT_WEBHOOK_URL env var");
  }

  let linksList;
  if (hubspotLinks.length === 0) {
    linksList = "No HubSpot tickets found in this release.";
  } else {
    linksList = hubspotLinks.map((link, i) => `${i + 1}. ${link}`).join("\n");
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
