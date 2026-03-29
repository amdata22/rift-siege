/**
 * Station log entries — multiple perspectives, tone escalates from professional to unraveling.
 * `order` is the canonical story sequence (HUD sorts by this when showing "the story so far").
 */
export const JOURNAL_ENTRIES = [
  {
    id: "log-01",
    order: 1,
    title: "Personal log — Day 1, arrival",
    text: `Cygnus X orientation went fine. Dr. Hale says the rift readings are "within expected variance." I'm logging everything per protocol. The crew seems tired but normal. Coffee in the mess actually tastes like coffee. Small miracle.`,
  },
  {
    id: "log-02",
    order: 2,
    title: "Personal log — Week 2",
    text: `Night shifts are long. I keep hearing something in the ducts — maintenance says it's thermal expansion. Probably right. I wrote it down anyway. Better paranoid on paper than sorry in a report.`,
  },
  {
    id: "log-hale-01",
    order: 3,
    title: "Dr. Hale — Research notes, Week 2",
    text: `Rift aperture has stabilized at 4.7 millisteads. Energy signature is unusual — there are harmonics we didn't see in the simulation data. I've notified Command. They want us to increase the containment field. I've doubled the emitter array output. Whatever is on the other side is... listening. Not my word. That's from Ensign Vargas's sensor notes, which I've quietly archived.`,
  },
  {
    id: "log-03",
    order: 4,
    title: "Personal log — Anomaly note",
    text: `Sector 4 sensors flickered for six minutes. No breach, no alarm. Hale called it "instrument jitter." I don't like that phrase. Jitter doesn't leave scratches on the inside of a panel that wasn't opened.`,
  },
  {
    id: "log-eng-01",
    order: 5,
    title: "Engineering log — Chief Okafor",
    text: `Containment emitter array at 140% rated capacity. I flagged this to Dr. Hale three times. She says Command approved the override. Fine. But when the coolant coupling on Emitter 7 blew at 0300, nobody from Command was standing in the spray. My crew patched it. We always patch it. I'm logging this for the record: if this station goes dark, it won't be because engineering didn't see it coming.`,
  },
  {
    id: "log-04",
    order: 6,
    title: "Personal log — Can't sleep",
    text: `Three hours last night. The walls hum. Not the lights — lower. Like something breathing through the bulkhead. I asked for a transfer. They said staffing is "stabilized." I didn't know we were unstable.`,
  },
  {
    id: "log-security-01",
    order: 7,
    title: "Security Chief Malverde — Incident report",
    text: `Crew member Tessler found unresponsive in Corridor 7-B at 0415. Vitals stable. Eyes open, tracking. Wouldn't speak. Medical cleared him physically. He resumed duty at 0800 without explanation. I've seen fear, and I've seen shock. This was neither. He moved like someone reading from a script they'd already memorized. I've posted a second officer on his rotation. Unofficially.`,
  },
  {
    id: "log-05",
    order: 8,
    title: "Personal log — The smiles",
    text: `People are smiling wrong. Same faces, same names, but the timing is off — half a second late, like they're listening for a cue. I laughed at lunch. It came out too loud. Everyone looked at me. I wrote this in the bathroom.`,
  },
  {
    id: "log-medbay-01",
    order: 9,
    title: "Medical bay — Dr. Reyes, clinical notes",
    text: `Three crew members brought in for observation in 48 hours. Presenting symptom in all cases: a fixed, forward stare and inability to initiate speech. When spoken to, they respond — appropriately, coherently — but they initiate nothing. EEGs show a recurring 0.4 Hz oscillation in the theta band that doesn't match any known state. It resembles synchronization. As if something external is setting their clock. I've sedated two of the three. The third asked me to stop. Very calmly. Said, "It doesn't hurt." I sedated them anyway. Their eyes stayed open.`,
  },
  {
    id: "log-06",
    order: 10,
    title: "Personal log — DO NOT TRUST THE COUNT",
    text: `Headcount says 47. I counted 46 walking past my door. Then 48. Then the list on the wall had a name I don't remember writing. The pen was in MY hand. The ink was still wet.`,
  },
  {
    id: "log-hale-02",
    order: 11,
    title: "Dr. Hale — Research notes, final entry",
    text: `I was wrong about the harmonic frequencies. They aren't a side effect of the rift — they ARE the rift. The aperture isn't a tear in space. It's a channel. Something has been using our containment field as a signal repeater for weeks. We've been broadcasting ourselves into it every time we increased power. And it has been answering. I tried to shut it down at 2240. The emitter array wouldn't accept my override. The station AI said my credentials were invalid. I have the highest clearance on the station. I understand now. I am no longer alone in my access level.`,
  },
  {
    id: "log-07",
    order: 12,
    title: "Personal log — they know i know",
    text:
      "If you're reading this I'm already wrong about something. Maybe I'm already not me. The cameras track me but the red lights don't blink when I move — only when I STOP. They're learning my stillness. Words feel WRONG wrong wron g. I typed \"stillness\" three times and the third one came out sideways on the screen.",
  },
  {
    id: "log-security-02",
    order: 13,
    title: "Security Chief Malverde — FINAL BROADCAST",
    text: `This is Chief Malverde, Cygnus X Security. Timestamp 0312. If anyone receives this — do not approach the station. Do not respond to the automated distress beacon. The beacon is not from us. I don't know what's in here but it started at the rift and it learned us from the inside out. It knows how to sound like us. My team is gone. I have one magazine left and I've barricaded myself in the security hub. It's saying my name through the door. With my voice. Do not come here. Do not — [TRANSMISSION ENDS]`,
  },
  {
    id: "log-08",
    order: 14,
    title: "Personal log — THE VOICE IN THE STATIC",
    text:
      'PA said my name. Clear as glass. Then the voice offered me "peace." I said yes without opening my mouth. My lips moved anyway. NOT ME NOT ME. static static s̸t̸a̸t̸i̸c̸ the letters are crawling off the display h̷e̷l̷l̷o̷ h̷e̷l̷l̷o̷ h̷e̷l̷p̷ ͏ ͏ ͏',
  },
  {
    id: "log-09",
    order: 15,
    title: "Personal log — beautiful beautiful beautiful",
    text:
      "The dark isn't empty. It's FULL. Full of teeth that don't bite yet. Full of hands that know my spine better than I do. Hale was right about one thing: the rift isn't a hole. It's a mouth. We walked in willingly.\n\nTHEN THE WORDS STOPPED MEANING\n\nb e a u t i f u l b e a u t i f u l b e a u t i f u l\n\nth̴e̴ ̴m̴o̴u̴t̴h̴ ̴i̴s̴ ̴a̴l̴l̴ ̴t̴e̴e̴t̴h̴ ̴a̴l̴l̴ ̴t̴e̴e̴t̴h̴ ̴a̴l̴l̴\n\n47 48 4̷9̷ ̷5̷0̷ ̷∞̷ ̷∞̷ ̷∞̷",
  },
  {
    id: "log-10",
    order: 16,
    title: "Personal log — final (final) (final)",
    text: `If you find this RUN RUN RUN don't look at the corners don't trust the count DON'T SLEEP they grow in the gap between blinks i left the door open FOR YOU come in come in COME IN we are so happy here we are so many now`,
  },
];

export const JOURNAL_BY_ID = Object.fromEntries(JOURNAL_ENTRIES.map((e) => [e.id, e]));

export function getJournalTotalCount() {
  return JOURNAL_ENTRIES.length;
}
