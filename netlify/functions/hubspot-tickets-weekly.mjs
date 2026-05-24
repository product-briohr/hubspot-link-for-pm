// Scheduled function: Every Friday 10AM MYT (02:00 UTC)
// Pulls Jira B2 release from Thursday, extracts HubSpot links, posts to Slack

import { getStore } from "@netlify/blobs";

export const config = {
  schedule: "0 2 * * 5" // Friday 10AM MYT (UTC+8 = 02:00 UTC)
};

const JIRA_CLOUD_ID = "e38dd556-d5ba-4444-8e93-93420ba8123c";

// ─── Structured logger ───────────────────────────────────────────────────────
function log(level, step, msg, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    step,
    msg,
    ...data
  };
  if (level === "ERROR") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────
export default async () => {
  const runId = Math.random().toString(36).slice(2, 10);
  log("INFO", "START", "Function invoked", { runId, env: process.env.NETLIFY_DEV ? "local" : "netlify" });

  try {
    // Step 1 — Resolve Thursday release date (releases are dated Thursdays)
    const releaseDate = getThursdayMYT();
    log("INFO", "DATE", "Resolved Thursday release date", { releaseDate, utcNow: new Date().toISOString() });

    // Step 2 — Find matching Jira release version
    log("INFO", "JIRA", "Searching for release version in Jira B2", { releaseDate });
    let version;
    try {
      version = await findReleaseForDate(releaseDate);
    } catch (err) {
      log("ERROR", "JIRA", "Failed to query Jira versions", { error: err.message, stack: err.stack });
      return new Response(`Jira version query failed: ${err.message}`, { status: 500 });
    }

    if (!version) {
      log("WARN", "JIRA", "No qualifying release found — skipping", { releaseDate });
      return new Response("No release found", { status: 200 });
    }
    log("INFO", "JIRA", "Release version found", { versionId: version.id, versionName: version.name, releaseDate: version.releaseDate });

    // Step 3 — Dedup guard: skip if already sent for this release
    let store;
    try {
      store = getStore("hubspot-dedup");
      const lastSent = await store.get("last-sent-release").catch(err => {
        log("WARN", "DEDUP", "Could not read dedup store — treating as first run", { error: err.message });
        return null;
      });
      log("INFO", "DEDUP", "Dedup check", { lastSent, currentRelease: version.name, willSkip: lastSent === version.name });
      if (lastSent === version.name) {
        log("WARN", "DEDUP", "Already sent for this release — aborting to prevent duplicate", { versionName: version.name });
        return new Response("Already sent", { status: 200 });
      }
    } catch (err) {
      log("WARN", "DEDUP", "Dedup store unavailable — proceeding without dedup guard", { error: err.message });
      store = null;
    }

    // Step 4 — Fetch Jira tickets for the release
    log("INFO", "JIRA", "Fetching tickets for version", { versionName: version.name });
    let issues;
    try {
      issues = await getIssuesForVersion(version.name);
    } catch (err) {
      log("ERROR", "JIRA", "Failed to fetch tickets", { versionName: version.name, error: err.message, stack: err.stack });
      return new Response(`Jira issue fetch failed: ${err.message}`, { status: 500 });
    }
    log("INFO", "JIRA", "Tickets fetched", {
      versionName: version.name,
      totalIssues: issues.length,
      issueKeys: issues.map(i => i.key),
      issueTypes: [...new Set(issues.map(i => i.fields?.issuetype?.name))]
    });

    // Step 5 — Extract HubSpot links from ticket descriptions
    const hubspotEntries = extractHubspotLinks(issues);
    log("INFO", "EXTRACT", "HubSpot link extraction complete", {
      inputIssues: issues.length,
      issuesWithLinks: hubspotEntries.length > 0 ? undefined : 0,
      hubspotLinksFound: hubspotEntries.length,
      links: hubspotEntries.map(e => ({ issueTitle: e.title, url: e.url }))
    });

    if (hubspotEntries.length === 0) {
      log("WARN", "EXTRACT", "No HubSpot links found in any ticket description — will still send Slack message");
    }

    // Step 6 — Send to Slack
    log("INFO", "SLACK", "Sending Slack message", { linkCount: hubspotEntries.length });
    try {
      await sendToSlack(hubspotEntries, version.name);
    } catch (err) {
      log("ERROR", "SLACK", "Failed to send Slack message", { error: err.message, stack: err.stack });
      return new Response(`Slack send failed: ${err.message}`, { status: 500 });
    }
    log("INFO", "SLACK", "Slack message sent successfully");

    // Step 7 — Write dedup record
    if (store) {
      try {
        await store.set("last-sent-release", version.name);
        log("INFO", "DEDUP", "Recorded sent release", { versionName: version.name });
      } catch (err) {
        log("WARN", "DEDUP", "Could not write dedup record — safe to continue", { error: err.message });
      }
    }

    log("INFO", "DONE", "Function completed successfully", { runId, versionName: version.name, linksSent: hubspotEntries.length });
    return new Response("OK", { status: 200 });

  } catch (err) {
    log("ERROR", "UNHANDLED", "Unhandled exception in main handler", { error: err.message, stack: err.stack });
    return new Response(`Unhandled error: ${err.message}`, { status: 500 });
  }
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

// Returns the date of yesterday in MYT (YYYY-MM-DD)
// Runs Friday 10AM MYT → yesterday = Thursday → matches Jira release dates
function getThursdayMYT() {
  const now = new Date();
  const myt = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  myt.setDate(myt.getDate() - 1); // yesterday = Thursday
  const y = myt.getFullYear();
  const m = String(myt.getMonth() + 1).padStart(2, "0");
  const d = String(myt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─── Jira helpers ─────────────────────────────────────────────────────────────

async function jiraFetch(path) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;

  if (!email || !token) {
    throw new Error("Missing JIRA_EMAIL or JIRA_API_TOKEN env vars");
  }

  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const url = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`;

  log("DEBUG", "JIRA_REQ", "GET request", { url });
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }
  });

  log("DEBUG", "JIRA_RES", "GET response", { url, status: res.status });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API ${res.status} on GET ${path}: ${body}`);
  }
  return res.json();
}

async function jiraPost(path, body) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;

  if (!email || !token) {
    throw new Error("Missing JIRA_EMAIL or JIRA_API_TOKEN env vars");
  }

  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const url = `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3${path}`;

  log("DEBUG", "JIRA_REQ", "POST request", { url, bodyPreview: JSON.stringify(body).slice(0, 200) });
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  log("DEBUG", "JIRA_RES", "POST response", { url, status: res.status });
  if (!res.ok) {
    const responseBody = await res.text();
    throw new Error(`Jira API ${res.status} on POST ${path}: ${responseBody}`);
  }
  return res.json();
}

async function findReleaseForDate(date) {
  log("DEBUG", "JIRA", "Fetching unreleased versions", { project: "B2" });
  const unreleased = await jiraFetch("/project/B2/version?status=unreleased&orderBy=-sequence&maxResults=50");
  const unreleasedList = unreleased.values || unreleased;
  log("DEBUG", "JIRA", "Unreleased versions scanned", {
    count: unreleasedList.length,
    versions: unreleasedList.map(v => ({ name: v.name, releaseDate: v.releaseDate }))
  });

  for (const v of unreleasedList) {
    if (v.releaseDate !== date) continue;
    if (/mobile|rn mobile|special/i.test(v.name)) {
      log("DEBUG", "JIRA", "Skipped version (mobile/special)", { name: v.name });
      continue;
    }
    if (!/^\d+\.\d+\.0$/.test(v.name)) {
      log("DEBUG", "JIRA", "Skipped version (name pattern mismatch)", { name: v.name, expected: "X.Y.0" });
      continue;
    }
    return v;
  }

  log("DEBUG", "JIRA", "No match in unreleased, checking released versions");
  const released = await jiraFetch("/project/B2/version?status=released&orderBy=-sequence&maxResults=20");
  const releasedList = released.values || released;
  log("DEBUG", "JIRA", "Released versions scanned", {
    count: releasedList.length,
    versions: releasedList.slice(0, 10).map(v => ({ name: v.name, releaseDate: v.releaseDate }))
  });

  for (const v of releasedList) {
    if (v.releaseDate !== date) continue;
    if (/mobile|rn mobile|special/i.test(v.name)) continue;
    if (!/^\d+\.\d+\.0$/.test(v.name)) continue;
    return v;
  }

  return null;
}

async function getIssuesForVersion(versionName) {
  const jql = `project = B2 AND fixVersion = "${versionName}" AND issuetype in (Story, Task, Hotfix, "Off Cycle")`;
  log("DEBUG", "JIRA", "JQL query", { jql });

  const data = await jiraPost("/search/jql", {
    jql,
    fields: ["summary", "description", "issuetype"],
    maxResults: 100
  });

  const issues = data.issues || [];
  log("DEBUG", "JIRA", "Issues returned", {
    total: data.total,
    returned: issues.length,
    issues: issues.map(i => ({ key: i.key, type: i.fields?.issuetype?.name, hasDescription: !!i.fields?.description }))
  });

  return issues;
}

// ─── HubSpot link extractor ───────────────────────────────────────────────────

function extractHubspotLinks(issues) {
  const seen = new Set();
  const entries = [];
  const hubspotRegex = /https?:\/\/app\.hubspot\.com\/contacts\/[^\s"<>\]|)]*/gi;

  for (const issue of issues) {
    const desc = issue.fields?.description;
    const title = issue.fields?.summary || "(no summary)";

    if (!desc) {
      log("DEBUG", "EXTRACT", "Issue has no description — skipping", { key: issue.key, title });
      continue;
    }

    const text = typeof desc === "string" ? desc : JSON.stringify(desc);
    const matches = text.match(hubspotRegex);

    if (!matches) {
      log("DEBUG", "EXTRACT", "No HubSpot links in description", { key: issue.key, title });
      continue;
    }

    let newForIssue = 0;
    let dupForIssue = 0;
    for (const url of matches) {
      const clean = url.replace(/[,;.]+$/, "");
      if (seen.has(clean)) {
        dupForIssue++;
        log("DEBUG", "EXTRACT", "Duplicate URL skipped", { key: issue.key, url: clean });
      } else {
        seen.add(clean);
        entries.push({ title, url: clean });
        newForIssue++;
      }
    }
    log("DEBUG", "EXTRACT", "Links extracted from issue", { key: issue.key, title, newLinks: newForIssue, duplicates: dupForIssue });
  }

  return entries;
}

// ─── Slack sender ─────────────────────────────────────────────────────────────

async function sendToSlack(hubspotEntries, versionName) {
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

  log("DEBUG", "SLACK", "Posting to webhook", { messageLength: message.length, linkCount: hubspotEntries.length });

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message })
  });

  log("DEBUG", "SLACK", "Webhook response", { status: res.status, statusText: res.statusText });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook ${res.status}: ${body}`);
  }
}
