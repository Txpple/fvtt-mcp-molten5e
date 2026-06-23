// Pure quest HTML/CSS templating — string in, string out, no Foundry/logger/IO.
// Extracted verbatim from QuestCreationTools (former private methods); only `this.X()` calls
// became direct/imported calls. Produces the styled journal HTML (Lost-Mine-of-Phandelver look)
// and the update-formatting used by create-quest-journal / update-quest-journal / link-quest-to-npc.

import {
  type QuestJournalRequest,
  generateBackgroundText,
  generateAdventureHook,
  generateQuestObjectives,
} from './quest-content.js';

/** Generate formatted quest content from request (HTML for Foundry v13 ProseMirror). */
export function generateQuestContent(request: QuestJournalRequest): string {
  // Build the HTML body content using professional template fragments
  const htmlBody = buildStyledQuestContent(request);

  // Wrap in styled template
  return createStyledJournal(request.questTitle, htmlBody);
}

/** Create a professional styled journal with CSS that mimics Lost Mine of Phandelver. */
export function createStyledJournal(title: string, htmlBody: string): string {
  return `
    <section class="mcp-journal">
      <style>
        .mcp-journal { --ink:#222; --muted:#666; --paper:#f8f5f2; --gm:#f2f2f2; --accent:#b33; --rule:#ddd; font-size:14px; line-height:1.6; color:var(--ink); }
        .mcp-journal .wrap { max-width: 980px; margin: 0 auto; padding: 8px 12px 24px; }
        .mcp-journal h1 { font-size: 28px; letter-spacing: .5px; text-align: center; margin: 8px 0 6px; }
        .mcp-journal .orn { height: 10px; border: 0; border-top: 2px solid var(--rule); margin: 8px auto 16px; width: 60%; }
        .mcp-journal h2 { font-size: 20px; margin: 18px 0 6px; }
        .mcp-journal h3 { font-size: 16px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .04em; }
        .mcp-journal p.lead { font-size: 15px; color: var(--muted); margin: 0 0 10px; }
        .mcp-journal .readaloud { background: var(--paper); border-left: 4px solid var(--accent); padding: 10px 12px; margin: 12px 0; }
        .mcp-journal .gmnote { background: var(--gm); border-left: 4px solid #444; padding: 10px 12px; margin: 12px 0; }
        .mcp-journal ul { margin: 6px 0 10px 18px; }
        .mcp-journal .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px 24px; }
        .mcp-journal img { max-width: 100%; height: auto; border-radius: 2px; }
        .mcp-journal .meta { font-size: 12px; color: var(--muted); margin: 4px 0 12px; }
        .mcp-journal table { border-collapse: collapse; width: 100%; }
        .mcp-journal table th, .mcp-journal table td { border-bottom: 1px solid var(--rule); padding: 6px 4px; text-align: left; }
        .mcp-journal .spaced { margin-top: 14px; }
      </style>

      <div class="wrap">
        <h1>${title}</h1>
        <hr class="orn"/>

        ${htmlBody}
      </div>
    </section>`;
}

/** Build professional quest content using template fragments. */
export function buildStyledQuestContent(request: QuestJournalRequest): string {
  let htmlBody = '';

  // Lead paragraph with quest summary
  htmlBody += `<p class="lead">${request.questDescription}</p>`;

  // Background section (if we have enough detail to warrant it)
  if (request.location || request.questGiver || request.npcName) {
    htmlBody += '<h2>Background</h2>';
    const backgroundText = generateBackgroundText(request);
    htmlBody += `<p>${backgroundText}</p>`;
  }

  // Quest details in two-column layout
  if (
    request.questType ||
    request.difficulty ||
    request.location ||
    request.npcName ||
    request.rewards
  ) {
    htmlBody += '<div class="grid-2">';

    // Left column - Quest Details
    htmlBody += '<div><h3>Quest Details</h3><ul>';

    if (request.questType) {
      htmlBody += `<li><strong>Type:</strong> ${request.questType.charAt(0).toUpperCase() + request.questType.slice(1)} Quest</li>`;
    }

    if (request.difficulty) {
      htmlBody += `<li><strong>Difficulty:</strong> ${request.difficulty.charAt(0).toUpperCase() + request.difficulty.slice(1)}</li>`;
    }

    if (request.location) {
      htmlBody += `<li><strong>Location:</strong> ${request.location}</li>`;
    }

    if (request.questGiver) {
      htmlBody += `<li><strong>Quest Giver:</strong> ${request.questGiver}</li>`;
    }

    if (request.npcName) {
      htmlBody += `<li><strong>Key NPC:</strong> ${request.npcName}</li>`;
    }

    htmlBody += '</ul></div>';

    // Right column - Rewards & Status
    htmlBody += '<div><h3>Rewards & Status</h3><ul>';

    if (request.rewards) {
      htmlBody += `<li><strong>Rewards:</strong> ${request.rewards}</li>`;
    }

    htmlBody += `<li><strong>Status:</strong> Active</li>`;
    htmlBody += `<li><strong>Created:</strong> ${new Date().toLocaleDateString()}</li>`;

    htmlBody += '</ul></div>';
    htmlBody += '</div>'; // Close grid-2
  }

  // Adventure Hook section with proper quest giver logic
  htmlBody += '<h2 class="spaced">Adventure Hook</h2>';
  htmlBody += '<div class="readaloud">';

  const hookText = generateAdventureHook(request);
  htmlBody += hookText;
  htmlBody += '</div>';

  // GM Notes section with specific guidance
  htmlBody += '<div class="gmnote">';
  let gmNotes = '<p><strong>GM Notes:</strong> ';

  if (request.difficulty) {
    gmNotes += `This ${request.difficulty} difficulty quest `;
  } else {
    gmNotes += 'This quest ';
  }

  if (request.questType) {
    gmNotes += `is designed as a ${request.questType} quest. `;
  }

  gmNotes +=
    "Adjust encounters, NPCs, and obstacles to match your party's level and campaign tone. ";

  if (request.location) {
    gmNotes += `Consider the specific details of ${request.location} in your world. `;
  }

  if (request.rewards) {
    gmNotes +=
      "The specified rewards can be modified to better fit your campaign's economy and progression.";
  } else {
    gmNotes +=
      "Consider appropriate rewards based on the quest's difficulty and your party's level.";
  }

  gmNotes += '</p>';
  htmlBody += gmNotes;
  htmlBody += '</div>';

  // Quest Objectives section with intelligent objectives
  htmlBody += '<h2 class="spaced">Quest Objectives</h2>';
  htmlBody += '<ul>';

  const objectives = generateQuestObjectives(request);
  objectives.forEach(objective => {
    htmlBody += `<li>${objective}</li>`;
  });

  htmlBody += '</ul>';

  // Progress tracking section
  htmlBody += '<h2 class="spaced">Progress Notes</h2>';
  htmlBody += '<div class="gmnote">';
  htmlBody +=
    '<p><strong>GM Note:</strong> Use this section to track quest progress, player decisions, and any modifications made during gameplay.</p>';
  htmlBody += '</div>';

  return htmlBody;
}

/**
 * Add NPC link information to journal content (HTML for Foundry v13 ProseMirror).
 * Maintains professional styling by adding to the grid layout.
 */
export function addNPCLinkToJournal(
  content: string,
  npcName: string,
  relationship: string
): string {
  const relationshipText = relationship.replace(/([A-Z])/g, ' $1').toLowerCase();

  // Look for existing Related NPCs section in the grid
  if (content.includes('<h3>Related NPCs</h3>')) {
    // Add to existing NPC list
    return content.replace(
      '</ul></div></div>',
      `<li><strong>${npcName}:</strong> ${relationshipText}</li></ul></div></div>`
    );
  } else {
    // Find the end of the right column in the grid and add NPC section
    if (content.includes('<h3>Rewards & Status</h3>')) {
      const npcSection = `<li><strong>Related NPCs:</strong></li><li><strong>${npcName}:</strong> ${relationshipText}</li>`;
      return content.replace('</ul></div></div>', `${npcSection}</ul></div></div>`);
    } else {
      // If no grid exists, add a new GM note section for NPCs
      const npcSection = `<div class="gmnote"><p><strong>Related NPCs:</strong> ${npcName} (${relationshipText})</p></div>`;
      return content.replace('</div></section>', `${npcSection}</div></section>`);
    }
  }
}

/** Format content for a brand new page (no existing content to append to). */
export function formatNewPageContent(newContent: string, updateType: string): string {
  const timestamp = new Date().toLocaleDateString();
  const formattedContent = formatUpdateContentForFoundry(newContent);
  const hasCustomHeading = /<h[1-6][^>]*>.*<\/h[1-6]>/i.test(newContent);

  if (hasCustomHeading) {
    return `<section class="mcp-journal">${formattedContent}</section>`;
  }

  let heading = '';
  switch (updateType) {
    case 'progress':
      heading = `<h2 class="spaced">Progress Update - ${timestamp}</h2>`;
      break;
    case 'completion':
      heading = `<h2 class="spaced">Quest Completed - ${timestamp}</h2>`;
      break;
    case 'failure':
      heading = `<h2 class="spaced">Quest Failed - ${timestamp}</h2>`;
      break;
    case 'modification':
      heading = `<h2 class="spaced">Quest Modified - ${timestamp}</h2>`;
      break;
  }

  return `<section class="mcp-journal">${heading}<div class="gmnote">${formattedContent}</div></section>`;
}

/** Format quest update based on type (HTML for Foundry v13 ProseMirror). */
export function formatQuestUpdate(
  currentContent: string,
  newContent: string,
  updateType: string
): string {
  const timestamp = new Date().toLocaleDateString();
  const formattedContent = formatUpdateContentForFoundry(newContent);
  let updateSection = '';

  // Check if content already has custom headings (like "<h2>The Thorned Grove</h2>")
  const hasCustomHeading = /<h[1-6][^>]*>.*<\/h[1-6]>/i.test(newContent);

  if (hasCustomHeading) {
    // Content already has themed sections - insert directly as peer sections
    // This allows custom headings like "<h2>The Thorned Grove</h2>" to be main sections
    updateSection = formattedContent;
  } else {
    // Create styled update section with generic headings
    switch (updateType) {
      case 'progress':
        updateSection = `<h2 class="spaced">Progress Update - ${timestamp}</h2><div class="gmnote">${formattedContent}</div>`;
        break;
      case 'completion':
        updateSection = `<h2 class="spaced">Quest Completed - ${timestamp}</h2><div class="readaloud">${formattedContent}</div>`;
        break;
      case 'failure':
        updateSection = `<h2 class="spaced">Quest Failed - ${timestamp}</h2><div class="gmnote">${formattedContent}</div>`;
        break;
      case 'modification':
        updateSection = `<h2 class="spaced">Quest Modified - ${timestamp}</h2><div class="gmnote">${formattedContent}</div>`;
        break;
    }
  }

  // Update quest status in the grid for completion/failure
  if (updateType === 'completion') {
    currentContent = currentContent.replace(
      '<li><strong>Status:</strong> Active</li>',
      '<li><strong>Status:</strong> Completed</li>'
    );
  } else if (updateType === 'failure') {
    currentContent = currentContent.replace(
      '<li><strong>Status:</strong> Active</li>',
      '<li><strong>Status:</strong> Failed</li>'
    );
  }

  // Add the update section before the closing section tag
  // Handle both possible closing patterns (with/without spacing)
  if (currentContent.includes('</div>\n    </section>')) {
    return currentContent.replace(
      '</div>\n    </section>',
      `${updateSection}</div>\n    </section>`
    );
  } else {
    return currentContent.replace('</div></section>', `${updateSection}</div></section>`);
  }
}

/**
 * Format update content for Foundry VTT (preserve HTML like create-quest-journal).
 * Allows custom section headings and themed content with proper CSS classes.
 */
export function formatUpdateContentForFoundry(content: string): string {
  // Trim whitespace
  const trimmed = content.trim();

  if (!trimmed) {
    return '<p></p>';
  }

  // Check if content already contains HTML tags - preserve them like create-quest-journal
  const hasHTMLTags = /<[^>]+>/.test(trimmed);

  if (hasHTMLTags) {
    // Content already has HTML structure - return as-is for themed sections
    // This allows custom headings like "<h2>The Thorned Grove</h2>" to work properly
    return trimmed;
  } else {
    // Plain text content - convert to paragraphs with line break handling
    const paragraphs = trimmed.split('\n\n').filter(p => p.trim().length > 0);

    if (paragraphs.length === 0) {
      return '<p></p>';
    }

    if (paragraphs.length === 1) {
      // Single paragraph - handle line breaks within it
      return `<p>${paragraphs[0].replace(/\n/g, '<br>')}</p>`;
    }

    // Multiple paragraphs
    return paragraphs.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  }
}
