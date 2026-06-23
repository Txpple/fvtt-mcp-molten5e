// Pure quest prose generators — string in, string out, no Foundry/logger/IO.
// Extracted verbatim from QuestCreationTools so the tool class stays thin orchestration.
// (Behavior is byte-identical to the former private methods; only `this.X()` calls became
// direct calls within this module.)

export interface QuestJournalRequest {
  questTitle: string;
  questDescription: string;
  questType?:
    | 'main'
    | 'side'
    | 'personal'
    | 'mystery'
    | 'fetch'
    | 'escort'
    | 'kill'
    | 'collection'
    | undefined;
  difficulty?: 'easy' | 'medium' | 'hard' | 'deadly' | undefined;
  location?: string | undefined;
  questGiver?: string | undefined;
  npcName?: string | undefined;
  rewards?: string | undefined;
}

/** Generate background text using separate quest giver and NPC parameters. */
export function generateBackgroundText(request: QuestJournalRequest): string {
  let backgroundText = '';

  if (request.questGiver && request.location) {
    backgroundText = `This quest is provided by ${request.questGiver} and takes place in ${request.location}. `;
  } else if (request.questGiver) {
    backgroundText = `This quest is provided by ${request.questGiver}. `;
  } else if (request.location) {
    backgroundText = `This quest takes place in ${request.location}. `;
  } else {
    backgroundText = `This quest involves the party's investigation and action. `;
  }

  if (request.npcName) {
    backgroundText += `The quest centers around ${request.npcName}. `;
  }

  backgroundText += 'Adjust these details as needed for your campaign.';
  return backgroundText;
}

/** Generate adventure hook with proper quest giver logic and complete sentences. */
export function generateAdventureHook(request: QuestJournalRequest): string {
  let hookText = '<p><strong>Read-Aloud:</strong> ';

  if (request.questGiver) {
    // Use the explicit quest giver with crafted dialogue
    hookText += `${request.questGiver} approaches the party with evident concern. `;

    if (request.location && request.npcName) {
      hookText += `"There's been trouble in ${request.location} involving ${request.npcName}. `;
    } else if (request.location) {
      hookText += `"Something troubling is happening in ${request.location}. `;
    } else if (request.npcName) {
      hookText += `"I need to tell you about ${request.npcName}. `;
    } else {
      hookText += `"I have urgent news that requires your attention. `;
    }

    // Create specific dialogue based on quest type and content
    const hookDialogue = generateQuestGiverDialogue(request);
    hookText += `${hookDialogue}" ${request.questGiver} pauses, clearly hoping you'll take action.`;
  } else {
    // No explicit quest giver - use rumors/reports format
    if (request.location) {
      hookText += `Troubling reports reach your ears concerning ${request.location}. `;
    } else {
      hookText += `Disturbing rumors begin circulating in the area. `;
    }

    // Create specific rumor content
    const rumorContent = generateRumorHook(request);
    hookText += `${rumorContent} The situation clearly demands investigation before it worsens.`;
  }

  hookText += '</p>';
  return hookText;
}

/** Generate quest giver dialogue based on quest content. */
export function generateQuestGiverDialogue(request: QuestJournalRequest): string {
  const desc = request.questDescription.toLowerCase();

  if (desc.includes('blight') || desc.includes('corruption')) {
    return `A strange blight is spreading, and crops are turning into something unnatural. The situation grows worse by the day`;
  } else if (desc.includes('missing') || desc.includes('disappeared')) {
    return `People have been going missing, and we fear the worst. Someone needs to find out what's happening`;
  } else if (desc.includes('bandits') || desc.includes('raiders')) {
    return `Bandits have been terrorizing travelers and merchants. The roads aren't safe anymore`;
  } else if (desc.includes('monster') || desc.includes('creature')) {
    return `A dangerous creature has been spotted in the area. People are too frightened to venture out`;
  } else if (desc.includes('cult') || desc.includes('ritual')) {
    return `Strange rituals and suspicious activities have been observed. Something dark is stirring`;
  } else if (request.npcName && isLikelyAntagonist(request.questDescription, request.npcName)) {
    return `${request.npcName} has become a threat to everyone in the area. Someone must stop them before more people get hurt`;
  } else {
    // Generic but compelling dialogue
    return `The situation has become dangerous, and innocent people are at risk. We need heroes to set things right`;
  }
}

/** Generate rumor-based hook content. */
export function generateRumorHook(request: QuestJournalRequest): string {
  const desc = request.questDescription.toLowerCase();

  if (desc.includes('wizard') || desc.includes('magic')) {
    return `Witnesses speak of uncontrolled magical experiments and their terrifying consequences.`;
  } else if (desc.includes('blight') || desc.includes('corruption')) {
    return `Farmers report that healthy crops are turning into hostile, animate creatures overnight.`;
  } else if (desc.includes('missing') || desc.includes('disappeared')) {
    return `Several people have vanished without a trace, leaving behind only mysterious circumstances.`;
  } else if (request.npcName) {
    return `Local tales speak of ${request.npcName} and the growing danger they represent to the community.`;
  } else {
    return `Multiple witnesses describe strange and threatening events that demand immediate investigation.`;
  }
}

/** Generate specific quest objectives based on type and parameters. */
export function generateQuestObjectives(request: QuestJournalRequest): string[] {
  const objectives: string[] = [];

  // Add type-specific objectives
  if (request.questType === 'fetch') {
    objectives.push('Locate and retrieve the required item or information');
    if (request.location) {
      objectives.push(`Travel to ${request.location} and investigate thoroughly`);
    }
  } else if (request.questType === 'escort') {
    objectives.push('Safely escort the target to their destination');
    objectives.push('Protect against threats along the journey');
  } else if (request.questType === 'kill') {
    objectives.push('Eliminate the specified threat or enemy');
    objectives.push('Ensure the area is secure from further danger');
  } else if (request.questType === 'mystery') {
    objectives.push('Investigate the mysterious circumstances');
    objectives.push('Gather evidence and interview witnesses');
    objectives.push('Uncover the truth behind the events');
  } else {
    // For side quests and others, generate smart objectives
    if (request.npcName && isLikelyAntagonist(request.questDescription, request.npcName)) {
      objectives.push(`Investigate the situation involving ${request.npcName}`);
      if (request.location) {
        objectives.push(`Travel to ${request.location} and assess the threat`);
      }
      objectives.push(`Deal with ${request.npcName} as appropriate`);
    } else {
      // Create objectives from key action words in description
      const actionWords = extractActionObjectives(request.questDescription);
      objectives.push(...actionWords);
    }
  }

  // Add reporting objective based on quest giver
  if (request.questGiver) {
    objectives.push(`Report back to ${request.questGiver} upon completion`);
  } else {
    objectives.push('Report the outcome to the appropriate authorities');
  }

  // Add rewards objective if specified
  if (request.rewards) {
    objectives.push('Claim the promised rewards');
  }

  return objectives;
}

/** Check if NPC is likely an antagonist based on description. */
export function isLikelyAntagonist(description: string, npcName: string): boolean {
  const desc = description.toLowerCase();
  const name = npcName.toLowerCase().split(' ')[0]; // Use first name only

  const antagonistPhrases = [
    'confront',
    'stop',
    'defeat',
    'gone wrong',
    'obsessed',
    'mad',
    'threat',
    'corrupted',
    'evil',
    'dangerous',
  ];

  return antagonistPhrases.some(phrase => desc.includes(phrase)) && desc.includes(name);
}

/** Extract actionable objectives from quest description. */
export function extractActionObjectives(description: string): string[] {
  const objectives: string[] = [];

  // Look for action phrases in the description
  if (description.includes('investigate')) {
    objectives.push('Investigate the mysterious circumstances');
  }
  if (description.includes('navigate')) {
    objectives.push('Navigate through the dangerous area');
  }
  if (description.includes('confront')) {
    objectives.push('Confront the source of the problem');
  }
  if (description.includes('stop') || description.includes('prevent')) {
    objectives.push('Prevent further spread of the threat');
  }

  // If no specific actions found, create generic objective
  if (objectives.length === 0) {
    const words = description.split(' ');
    const briefObjective = words.slice(0, 15).join(' ') + (words.length > 15 ? '...' : '');
    objectives.push(`Complete the main objective: ${briefObjective}`);
  }

  return objectives;
}
