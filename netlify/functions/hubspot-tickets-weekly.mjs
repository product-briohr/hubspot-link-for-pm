// Scheduled function: Every Thursday 2PM MYT (6AM UTC)
// Pulls Jira B2 release for this week, extracts HubSpot links, posts to Slack #professional-overthinkers

export const config = {
  schedule: "0 6 * * 4" // 2PM MYT (UTC+8) every Thursday
};

const JIRA_CLOUD_ID = "e38dd556-d5ba-4444-8e93-93420ba8123c";

function log(level, step, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, step, msg, ...data };
  level === "ERROR" ? console.error(JSON.stringify(entry)) : console.log(JSON.stringify(entry));
}

export default async () => {
  try {
    log("INFO", "START", "Function invoked", { utcNow: new Date().toISOString() });

    // Validate env vars
    const missing = ["JIRA_EMAIL", "JIRA_API_TOKEN", "SLACK_HUBSPOT_WEBHOOK_URL"].filter(k => !process.env[k]);
    if (missing.length > 0) {
      log("ERROR", "ENV", "Missing required environment variables", { missing });
      return new Response(`Missing env vars: ${missing.join(", ")}`, { status: 500 });
    }
    log("INFO", "ENV", "All environment variables present");

    const { from: weekStart, to: weekEnd } = getWeekRangeMYT();
    log("INFO", "DATE", "Resolved week range in MYT", { weekStart, weekEnd, utcNow: new Date().toISOString() });

    // Step 1: Find the release version within this week (Mon–Thu)
    const version = await findWeekRelease(weekStart, weekEnd);
    if (!version) {
      log("WARN", "JIRA", "No qualifying release found this week — skipping", { weekStart, weekEnd });
      return new Response("No release found", { status: 200 });
    }
    log("INFO", "JIRA", "Found qualifying release", { name: version.name, releaseDate: version.releaseDate });

    // Step 2: Get qualifying tickets
    const issues = await getIssuesForVersion(version.name);
    log("INFO", "JIRA", "Tickets fetched", {
      versionName: version.name,
      total: issues.length,
      issueKeys: issues.map(i => i.key),
      issueTypes: [...new Set(issues.map(i => i.fields?.issuetype?.name))]
    });

    // Step 3: Extract HubSpot links
    const hubspotEntries = extractHubspotLinks(issues);
    log("INFO", "EXTRACT", "HubSpot extraction complete", {
      ticketsScanned: issues.length,
      linksFound: hubspotEntries.length,
      links: hubspotEntries.map(e => ({ title: e.title, url: e.url }))
    });

    // Step 4: Send to Slack
    await sendToSlack(hubspotEntries);
    log("INFO", "DONE", "Function completed successfully", { versionName: version.name, linksSent: hubspotEntries.length });

    return new Response("OK", { status: 200 });
  } catch (err) {
    log("ERROR", "FATAL", "Unhandled error", { error: err.message, stack: err.stack });
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

function getWeekRangeMYT() {
  const now = new Date();
  const myt = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  const day = myt.getDay(); // 0=Sun, 1=Mon, ..., 4=Thu
  // Monday of this week
  const monday = new Date(myt);
  monday.setDate(myt.getDate() - (day === 0 ? 6 : day - 1));
  // Today (Thursday when scheduled)
  const today = new Date(myt);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  return { from: fmt(monday), to: fmt(today) };
}

async function jiraFetch(path) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const url = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`;

  log("DEBUG", "JIRA_REQ", "GET", { url });
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }
  });
  log("DEBUG", "JIRA_RES", "GET response", { url, status: res.status });

  if (!res.ok) {
    throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function jiraPost(path, body) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const url = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`;

  log("DEBUG", "JIRA_REQ", "POST", { url, jql: body.jql });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  log("DEBUG", "JIRA_RES", "POST response", { url, status: res.status });

  if (!res.ok) {
    throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function findWeekRelease(from, to) {
  log("INFO", "JIRA", "Searching for release version in week range", { from, to, project: "B2" });

  const versions = await jiraFetch("/project/B2/version?status=unreleased&orderBy=-sequence&maxResults=50");
  const versionList = versions.values || versions;
  log("DEBUG", "JIRA", "Unreleased versions fetched", {
    count: versionList.length,
    versions: versionList.map(v => ({ name: v.name, releaseDate: v.releaseDate }))
  });

  for (const v of versionList) {
    if (!v.releaseDate || v.releaseDate < from || v.releaseDate > to) continue;
    if (/mobile|rn mobile|special/i.test(v.name)) {
      log("DEBUG", "JIRA", "Version skipped (excluded pattern)", { name: v.name });
      continue;
    }
    if (!/^\d+\.\d+\.0$/.test(v.name)) {
      log("DEBUG", "JIRA", "Version skipped (name pattern mismatch)", { name: v.name, expected: "X.X.0" });
      continue;
    }
    log("INFO", "JIRA", "Qualifying version found in unreleased", { name: v.name, releaseDate: v.releaseDate });
    return v;
  }

  log("DEBUG", "JIRA", "No match in unreleased — checking released versions");
  const released = await jiraFetch("/project/B2/version?status=released&orderBy=-sequence&maxResults=20");
  const releasedList = released.values || released;
  log("DEBUG", "JIRA", "Released versions fetched", {
    count: releasedList.length,
    versions: releasedList.slice(0, 10).map(v => ({ name: v.name, releaseDate: v.releaseDate }))
  });

  for (const v of releasedList) {
    if (!v.releaseDate || v.releaseDate < from || v.releaseDate > to) continue;
    if (/mobile|rn mobile|special/i.test(v.name)) continue;
    if (!/^\d+\.\d+\.0$/.test(v.name)) continue;
    log("INFO", "JIRA", "Qualifying version found in released", { name: v.name, releaseDate: v.releaseDate });
    return v;
  }

  log("WARN", "JIRA", "No qualifying version found in week range", { from, to });
  return null;
}

async function getIssuesForVersion(versionName) {
  const jql = `project = B2 AND fixVersion = "${versionName}" AND issuetype in (Story, Task, Hotfix, "Off Cycle")`;
  log("INFO", "JIRA", "Fetching tickets", { versionName, jql });

  const data = await jiraPost("/search/jql", {
    jql,
    fields: ["summary", "description", "issuetype"],
    maxResults: 100
  });
  return data.issues || [];
}

function extractTextFromAdf(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  if (node.type === "inlineCard" || node.type === "blockCard") {
    return node.attrs?.url ?? "";
  }
  const children = node.content ?? [];
  return children.map(extractTextFromAdf).join(" ");
}

function extractHubspotLinks(issues) {
  const seen = new Set();
  const entries = [];
  const hubspotRegex = /https:\/\/app\.hubspot\.com[^\s\])"<>]*/g;

  for (const issue of issues) {
    const desc = issue.fields?.description;
    const title = issue.fields?.summary || "";
    if (!desc) {
      log("DEBUG", "EXTRACT", "No description", { key: issue.key, title });
      continue;
    }

    const text = typeof desc === "string" ? desc : extractTextFromAdf(desc);
    const matches = [...text.matchAll(hubspotRegex)].map(m => m[0].replace(/[,;.]+$/, "").trim());

    if (matches.length === 0) {
      log("DEBUG", "EXTRACT", "No HubSpot links in ticket", { key: issue.key, title });
      continue;
    }

    let newLinks = 0;
    for (const url of matches) {
      if (!seen.has(url)) {
        seen.add(url);
        entries.push({ title, url });
        newLinks++;
      }
    }
    log("DEBUG", "EXTRACT", "Links extracted", { key: issue.key, title, newLinks });
  }

  return entries;
}

async function sendToSlack(hubspotEntries) {
  const webhookUrl = process.env.SLACK_HUBSPOT_WEBHOOK_URL;

  let linksList;
  if (hubspotEntries.length === 0) {
    linksList = "No HubSpot tickets found in this release.";
  } else {
    linksList = hubspotEntries.map((entry, i) => `${i + 1}. ${entry.title}\n    ${entry.url}`).join("\n");
  }

  const message = `Hey <!subteam^S04S66530SX>, PM Pic of this week release. Please update all the hubspot ticket status to "Tech Status = Deployed" and move it back to "Re-engage Client/Support Team Clarification". Here's the list of the hubspot ticket\n\n${linksList}`;

  log("INFO", "SLACK", "Sending message", { linkCount: hubspotEntries.length, messageLength: message.length });

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message })
  });

  if (!res.ok) {
    const body = await res.text();
    log("ERROR", "SLACK", "Webhook failed", { status: res.status, body });
    throw new Error(`Slack webhook error ${res.status}: ${body}`);
  }

  log("INFO", "SLACK", "Message sent successfully");
}
