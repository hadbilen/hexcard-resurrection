/**
 * Tier 1 test corpus (spec 04 Requirement 4.6): free-form English prompts that are not Grimoire
 * entries (paraphrases, other word orders, synonyms, typos, multi-step requests) with the expected
 * outcome of each. `expect` is the expected script as HexTalk (the test parses it into the
 * expected AST), or `null` when the right outcome is "not understood" with suggestions.
 *
 * Requirement 4.6: at least 60 prompts, every prompt has an expected outcome (a script or a
 * refusal) and Tier 1 matches 100% of them; at least 75% of the prompts expect a script.
 */
import type { SpellObjectKind } from "../spellcaster.ts";

export interface CorpusEntry {
  prompt: string;
  /** Object whose script is conjured; default "button". */
  kind?: SpellObjectKind;
  expect: string | null;
}

const on = (event: string, ...lines: string[]): string => [`on ${event}`, ...lines.map((line) => `  ${line}`), `end ${event}`].join("\n");
const click = (...lines: string[]): string => on("mouseUp", ...lines);

export const TIER1_CORPUS: readonly CorpusEntry[] = [
  // ----- navigation and visual effects -----
  { prompt: "when clicked, dissolve to the next card", expect: click("visual effect dissolve", "go next") },
  { prompt: "go to the next card using a slow dissolve", expect: click("visual effect dissolve slow", "go next") },
  { prompt: "Take me back to the previous card", expect: click("go prev") },
  { prompt: "please go to the first card", expect: click("go first") },
  { prompt: "jump to the last card with a wipe left", expect: click("visual effect wipe left", "go last") },
  { prompt: "Navigate to card 'Hall' with an iris open effect", expect: click("visual effect iris open", 'go to card "Hall"') },
  { prompt: "go to card 3", expect: click("go to card 3") },
  { prompt: "go to the third card", expect: click("go to card 3") },
  { prompt: "return to the card named Kitchen", expect: click('go to card "Kitchen"') },
  { prompt: "flip to the next page with venetian blinds", expect: click("visual effect venetian blinds", "go next") },
  { prompt: "Go nxt card", expect: click("go next") },
  { prompt: "dissolve to teh previous card", expect: click("visual effect dissolve", "go prev") },
  { prompt: "go back", expect: click("go back") },
  { prompt: "when double clicked, go to the first card", expect: on("mouseDoubleClick", "go first") },
  { prompt: "go to card 'Hall' and then go to card 'Kitchen' with a dissolve", expect: click('go to card "Hall"', "visual effect dissolve", 'go to card "Kitchen"') },
  // ----- sound -----
  { prompt: "when the card opens, play a spooky harpsichord tune", kind: "card", expect: on("openCard", 'play harpsichord "e3q g3q a#3q a3h e3q g3q f#3h"') },
  { prompt: "play a harpsicord fanfare", expect: click('play harpsichord "c4e e4e g4e c5q g4e c5h"') },
  { prompt: "play the flute melody 'c4q e4q g4h' at 90 bpm", expect: click('play flute tempo 90 "c4q e4q g4h"') },
  { prompt: "play 'c4e d4e e4e' on the flute at tempo 140", expect: click('play flute tempo 140 "c4e d4e e4e"') },
  { prompt: "make a boing sound", expect: click('play boing "c4q"') },
  { prompt: "play an 8 bit beep twice", expect: click("repeat 2 times", '  play square8bit "a5e"', "  wait 15 ticks", "end repeat") },
  { prompt: "beep 5 times", expect: click("repeat 5 times", '  play square8bit "a5e"', "  wait 15 ticks", "end repeat") },
  { prompt: "play a click sound when pressed", expect: click('play click "c4q"') },
  { prompt: "play a happy chiptune jingle quickly", expect: click('play square8bit tempo 180 "c5s e5s g5s c6q g5s c6h"') },
  { prompt: "Play a sad tune slowly on the flute", expect: click('play flute tempo 80 "c4q b3q a3q g3h"') },
  // ----- dialogs -----
  { prompt: "say hello", expect: click('answer "hello"') },
  { prompt: "show a message saying 'You found the key!'", expect: click('answer "You found the key!"') },
  { prompt: "display an alert that says 'Game over'", expect: click('answer "Game over"') },
  { prompt: "answer 'Do you want to continue?' with Yes or No", expect: click('answer "Do you want to continue?" with "Yes" or "No"') },
  { prompt: "ask the user for their favorite color and save it in field 'Color'", expect: click('ask "What is your favorite color?"', 'put it into field "Color"') },
  { prompt: "ask 'What is your quest?' and put the answer into field 'Quest'", expect: click('ask "What is your quest?"', 'put it into field "Quest"') },
  { prompt: "Ask the player for their name, then store it in card field 'Hero'", expect: click('ask "What is your name?"', 'put it into card field "Hero"') },
  // ----- containers and arithmetic -----
  { prompt: "put 'Hello' into field 'Greeting'", expect: click('put "Hello" into field "Greeting"') },
  { prompt: "set field 'Status' to 'Ready'", expect: click('put "Ready" into field "Status"') },
  { prompt: "clear field 'Notes'", expect: click('put empty into field "Notes"') },
  { prompt: "put the date into field 'Today' when the card opens", kind: "card", expect: on("openCard", 'put the date into field "Today"') },
  { prompt: "show the time in field 'Clock' on idle", kind: "card", expect: on("idle", 'put the time into field "Clock"') },
  { prompt: "add 10 to the score", expect: click('add 10 to field "score"') },
  { prompt: "add 1 point to field 'Score'", expect: click('add 1 to field "Score"') },
  { prompt: "increase lives by 1", expect: click('add 1 to field "lives"') },
  { prompt: "decrease the counter by 2", expect: click('subtract 2 from field "counter"') },
  { prompt: "subtract 5 from field 'Health'", expect: click('subtract 5 from field "Health"') },
  { prompt: "double the score", expect: click('multiply field "score" by 2') },
  { prompt: "increment field 'Visits' when the card opens", kind: "card", expect: on("openCard", 'add 1 to field "Visits"') },
  { prompt: "count from 1 to 5 in field 'Count'", expect: click("repeat with i = 1 to 5", '  put i into field "Count"', "end repeat") },
  { prompt: "roll a die and show the result in field 'Dice'", expect: click("get random(6)", 'put it into field "Dice"') },
  { prompt: "put a random number between 1 and 10 into field 'Lucky'", expect: click('put random(10) into field "Lucky"') },
  // ----- part properties -----
  { prompt: "hide this button", expect: click("set the visible of me to false") },
  { prompt: "hide button 'Door' and show field 'Message'", expect: click('set the visible of button "Door" to false', 'set the visible of field "Message" to true') },
  { prompt: "make the 'Exit' button invisible", expect: click('set the visible of button "Exit" to false') },
  { prompt: "disable button 'Next'", expect: click('set the enabled of button "Next" to false') },
  { prompt: "check this checkbox", expect: click("set the hilite of me to true") },
  { prompt: "toggle the visibility of field 'Hint'", expect: click('set the visible of field "Hint" to not the visible of field "Hint"') },
  { prompt: "rename this button to 'Pressed'", expect: click('set the name of me to "Pressed"') },
  { prompt: "set the text size of field 'Title' to 24", expect: click('set the textSize of field "Title" to 24') },
  { prompt: "lock field 'Answer'", expect: click('set the lockText of field "Answer" to true') },
  { prompt: "mark this card", expect: click("set the marked of this card to true") },
  { prompt: "move this button to 100,200", expect: click('set the location of me to "100,200"') },
  {
    prompt: "shake this button 5 times",
    expect: click(
      "put the location of me into home",
      "repeat 5 times",
      '  set the location of me to the mouseH + 4 & "," & the mouseV',
      "  wait 2 ticks",
      '  set the location of me to the mouseH - 4 & "," & the mouseV',
      "  wait 2 ticks",
      "end repeat",
      "set the location of me to home",
    ),
  },
  {
    prompt: "flash the button 'Alarm' twice",
    expect: click(
      "repeat 2 times",
      '  set the hilite of button "Alarm" to true',
      "  wait 10 ticks",
      '  set the hilite of button "Alarm" to false',
      "  wait 10 ticks",
      "end repeat",
    ),
  },
  { prompt: "when the mouse enters, hilite this button", expect: on("mouseEnter", "set the hilite of me to true") },
  { prompt: "on mouse leave, unhilite this button", expect: on("mouseLeave", "set the hilite of me to false") },
  // ----- timing, conditions, fetch (multi-step) -----
  { prompt: "wait 2 seconds then go to the next card", expect: click("wait 2 seconds", "go next") },
  { prompt: "pause for half a second and play a beep", expect: click("wait 30 ticks", 'play square8bit "a5e"') },
  { prompt: "after 3 seconds go to card 1", expect: click("wait 3 seconds", "go to card 1") },
  { prompt: "if field 'Score' is greater than 50 then go to card 'Win'", expect: click('if field "Score" > 50 then go to card "Win"') },
  {
    prompt: "if the score reaches 100, play a victory fanfare and go to card 'Win'. Otherwise say 'Not yet'",
    expect: click('if field "score" >= 100 then', '  play square8bit "c5s e5s g5s c6q g5s c6h"', '  go to card "Win"', "else", '  answer "Not yet"', "end if"),
  },
  {
    prompt: "if this checkbox is checked go to the next card otherwise go to the previous card",
    expect: click("if the hilite of me = true then", "  go next", "else", "  go prev", "end if"),
  },
  { prompt: "unless field 'Name' is empty, say 'Welcome back'", expect: click('if not (field "Name" = empty) then answer "Welcome back"') },
  {
    prompt: "answer 'Ready?' with 'Yes' or 'No', if the user clicks 'Yes' go to the next card",
    expect: click('answer "Ready?" with "Yes" or "No"', 'if it = "Yes" then go next'),
  },
  {
    prompt: "fetch https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m at path current.temperature_2m into field 'Temp'",
    expect: click('fetch "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m" at "current.temperature_2m" into field "Temp"'),
  },
  // ===== Families added with the generalised rules (task 5.1 rework) =====

  // ----- family 1: show / display / pop up / say a message (saying / that says) X -----
  { prompt: "show a message saying You found the treasure!", expect: click('answer "You found the treasure!"') },
  { prompt: "pop up an alert that says the door is locked", expect: click('answer "the door is locked"') },
  { prompt: "display a mesage: Welcome to the haunted house", expect: click('answer "Welcome to the haunted house"') },
  { prompt: "when the card opens, say a message saying Good evening", kind: "card", expect: on("openCard", 'answer "Good evening"') },
  { prompt: "popup a dialog reading 'Level complete' and go to the next card", expect: click('answer "Level complete"', "go next") },
  { prompt: "tell the player that the bridge is out", expect: click('answer "the bridge is out"') },
  { prompt: "show 'Saved!' in a dialog", expect: click('answer "Saved!"') },
  { prompt: "display a dialog with the text Hello there, then wait 1 second", expect: click('answer "Hello there"', "wait 1 seconds") },
  { prompt: "say 'Watch out' to the player", expect: click('answer "Watch out"') },
  { prompt: "show a message You win", expect: click('answer "You win"') },
  // must refuse: no marker and not a value; "that" after show is not a message; the comma cuts the message
  { prompt: "display the score in a popup", expect: null },
  { prompt: "show that the door is open", expect: null },
  { prompt: "pop up a message: Hello, world", expect: null },

  // ----- family 2: set the <property> of <objects> to <value>, every §4.1 property -----
  { prompt: "set the title of this button to 'Start'", expect: click('set the title of me to "Start"') },
  { prompt: "set the style of me to shadow", expect: click('set the style of me to "shadow"') },
  { prompt: "set the text style of field 'Title' to bold and italic", expect: click('set the textStyle of field "Title" to "bold,italic"') },
  {
    prompt: "change the auto hilite of button 'Go' and button 'Stop' to false",
    expect: click('set the autoHilite of button "Go" to false', 'set the autoHilite of button "Stop" to false'),
  },
  { prompt: "set the rect of field 'Map' to 10,20,200,120", expect: click('set the rect of field "Map" to "10,20,200,120"') },
  { prompt: "set the show name of me to off", expect: click("set the showName of me to false") },
  { prompt: "set the lock text of field Notes to true", expect: click('set the lockText of field "Notes" to true') },
  { prompt: "set the textFont of field 'Log' to mono", expect: click('set the textFont of field "Log" to "Mono"') },
  { prompt: "set my name to Start Game", expect: click('set the name of me to "Start Game"') },
  { prompt: "set the text size of field 'A' to twelve", expect: click('set the textSize of field "A" to 12') },
  { prompt: "set this button's title to 'Play'", expect: click('set the title of me to "Play"') },
  { prompt: "set the name of this card to The End", kind: "card", expect: on("openCard", 'set the name of this card to "The End"') },
  { prompt: "set the visibel of button 'Door' to false", expect: click('set the visible of button "Door" to false') },
  {
    prompt: "set the location of button 'Ghost' and field 'Note' to 100,50",
    expect: click('set the location of button "Ghost" to "100,50"', 'set the location of field "Note" to "100,50"'),
  },
  // must refuse: not a property; scrolling is a field style; 13 is not a text size
  { prompt: "set the color of this button to red", expect: null },
  { prompt: "set the style of this button to scrolling", expect: null },
  { prompt: "set the text size of field 'A' to 13", expect: null },

  // ----- family 3: subtract / lose / take away / decrease, number words, multi-word names -----
  { prompt: "lose 1 life", expect: click('subtract 1 from field "lives"') },
  { prompt: "the player loses a life", expect: click('subtract 1 from field "lives"') },
  { prompt: "take away 5 from Health", expect: click('subtract 5 from field "Health"') },
  { prompt: "take 3 away from field 'Gold'", expect: click('subtract 3 from field "Gold"') },
  { prompt: "remove two from field 'Coins'", expect: click('subtract 2 from field "Coins"') },
  { prompt: "decrease Health by three", expect: click('subtract 3 from field "Health"') },
  { prompt: "lose 10 health when the card opens", kind: "card", expect: on("openCard", 'subtract 10 from field "health"') },
  { prompt: "deduct 2 coins from field 'Purse'", expect: click('subtract 2 from field "Purse"') },
  { prompt: "substract 4 from the score", expect: click('subtract 4 from field "score"') },
  { prompt: "subtract twenty one from field 'Time'", expect: click('subtract 21 from field "Time"') },
  { prompt: "put 0 into field High Score", expect: click('put 0 into field "High Score"') },
  { prompt: "put 0 into the High Score field", expect: click('put 0 into field "High Score"') },
  { prompt: "go to card Game Over", expect: click('go to card "Game Over"') },
  { prompt: "go to card Game Over with a dissolve", expect: click("visual effect dissolve", 'go to card "Game Over"') },
  { prompt: "if field Lives is less than one go to card Game Over", expect: click('if field "Lives" < 1 then go to card "Game Over"') },
  // must refuse: the name has no certain end; "points" names no counter; "take" without away/from
  { prompt: "go to card Game over", expect: null },
  { prompt: "put 0 into field High Score points", expect: null },
  { prompt: "lose 10 points", expect: null },
  { prompt: "take 2 life", expect: null },

  // ----- family 4: yes or no questions -> answer Q with "Yes" or "No" -----
  { prompt: "ask a yes or no question: Are you ready?", expect: click('answer "Are you ready?" with "Yes" or "No"') },
  { prompt: "ask 'Do you want to save?' with yes and no", expect: click('answer "Do you want to save?" with "Yes" or "No"') },
  { prompt: "ask are you sure with yes or no", expect: click('answer "Are you sure?" with "Yes" or "No"') },
  { prompt: "ask the player a yes/no question: Shall we enter the crypt?", expect: click('answer "Shall we enter the crypt?" with "Yes" or "No"') },
  {
    prompt: "ask a yes or no question: Continue? If the user clicks Yes go to the next card",
    expect: click('answer "Continue?" with "Yes" or "No"', 'if it = "Yes" then go next'),
  },
  { prompt: "when the card opens ask a yes or no question: Is anybody there?", kind: "card", expect: on("openCard", 'answer "Is anybody there?" with "Yes" or "No"') },
  { prompt: "ask 'Ready?' as a yes or no question", expect: click('answer "Ready?" with "Yes" or "No"') },
  { prompt: "ask do you like ghosts with yes and no", expect: click('answer "Do you like ghosts?" with "Yes" or "No"') },
  { prompt: "ask teh player a yes or no question: Is it late?", expect: click('answer "Is it late?" with "Yes" or "No"') },
  // must refuse: "whether" does not start a question; no question given
  { prompt: "ask whether the player is ready with yes or no", expect: null },
  { prompt: "ask a yes or no question", expect: null },

  // ----- family 5: make a sound like X / sounds like X -----
  { prompt: "make a sound like a bell", expect: click('play harpsichord "e5e c5h"') },
  { prompt: "play a sound like a bouncing ball", expect: click('play boing "c4q"') },
  { prompt: "make a noise that sounds like an alarm", expect: click('play square8bit "a5e"') },
  { prompt: "play something that sounds like a ticking clock", expect: click('play click "c4q"') },
  { prompt: "when clicked, make it sound like the wind", expect: click('play flute "c4q"') },
  { prompt: "play a bell-like sound twice", expect: click("repeat 2 times", '  play harpsichord "e5e c5h"', "  wait 15 ticks", "end repeat") },
  { prompt: "make a sound like a spring and go to the next card", expect: click('play boing "c4q"', "go next") },
  { prompt: "play a whistling sound", expect: click('play flute "c4q"') },
  { prompt: "make a sound lik a chime", expect: click('play harpsichord "e5e c5h"') },
  // must refuse: unknown sounds (also one typo away from "wind"), two different voices
  { prompt: "make a sound like a dragon", expect: null },
  { prompt: "play a sound like a bouncing dragon", expect: null },
  { prompt: "make a sound like a wand", expect: null },
  { prompt: "play a flute sound like a bell", expect: null },

  // ===== Third rework: raw HexTalk, trigger synonyms, enable / disable =====

  // ----- family 6: raw HexTalk fallback (";" ends a line in the one-line prompt box) -----
  { prompt: "put Hello into field Greeting", expect: click('put "Hello" into field "Greeting"') },
  { prompt: "answer Welcome Home with OK", expect: click('answer "Welcome Home" with "OK"') },
  { prompt: "repeat with i = 1 to 5; put i into field Count; end repeat", expect: click("repeat with i = 1 to 5", '  put i into field "Count"', "end repeat") },
  { prompt: "put 1 into x; add x to field Total", expect: click("put 1 into x", 'add x to field "Total"') },
  { prompt: "put random(6) into field Dice", expect: click('put random(6) into field "Dice"') },
  { prompt: "get the number of cards; put it into field Total", expect: click("get the number of cards", 'put it into field "Total"') },
  { prompt: "on mouseUp; play boing \"c4q\"; go next; end mouseUp", expect: click('play boing "c4q"', "go next") },
  { prompt: "on openCard; put the time into field Clock; end openCard", kind: "card", expect: on("openCard", 'put the time into field "Clock"') },
  { prompt: "when the card opens, put Hello into field Greeting", kind: "card", expect: on("openCard", 'put "Hello" into field "Greeting"') },
  {
    prompt: "put Hello into field Greeting and go to the next card with a dissolve",
    expect: click('put "Hello" into field "Greeting"', "visual effect dissolve", "go next"),
  },
  { prompt: "if field Answer = Yes then go to card Game Over", expect: click('if field "Answer" = "Yes" then go to card "Game Over"') },
  {
    prompt: 'fetch "https://example.com/data.json" at "data.value" into field Result',
    expect: click('fetch "https://example.com/data.json" at "data.value" into field "Result"'),
  },
  { prompt: "answer Hello", expect: click('answer "Hello"') },
  { prompt: "put field Score + 10 into field Score", expect: click('put field "Score" + 10 into field "Score"') },
  { prompt: "if the hilite of me then go next", expect: click("if the hilite of me then go next") },
  { prompt: 'repeat 3 times; play boing "c4q"; end repeat', expect: click("repeat 3 times", '  play boing "c4q"', "end repeat") },
  { prompt: "put Hello World into field Greeting", expect: click('put "Hello World" into field "Greeting"') },
  { prompt: "go to card id 3", expect: click("go to card id 3") },
  { prompt: "visual effect iris open fast; go to card Hall", expect: click("visual effect iris open fast", 'go to card "Hall"') },
  { prompt: 'put "Score: " & field Score into field Status', expect: click('put "Score: " & field "Score" into field "Status"') },
  // English trigger "on mouseUp", then a HexTalk statement
  { prompt: "on mouseUp; go next", expect: click("go next") },
  // must refuse: lowercase unquoted word (variable or text?), a write nobody reads, a syntax error,
  // free variables in numeric slots, a lowercase multi-word name, http, a missing "end"
  { prompt: "put hello into field Greeting", expect: null },
  { prompt: "put Hello into Greeting", expect: null },
  { prompt: 'go to card "Hall', expect: null },
  { prompt: "if field Score > Limit then go next", expect: null },
  { prompt: "add Bonus to field Score", expect: null },
  { prompt: "go to card game over", expect: null },
  { prompt: 'fetch "http://example.com/data.json" into field Result', expect: null },
  { prompt: 'put "Hello" into', expect: null },
  { prompt: "set the enabled of this card to false", kind: "card", expect: null },

  // ----- family 7: trigger synonyms (every time / each time / whenever / after a click, hover) -----
  { prompt: "every time this button is clicked, add 1 to field 'Clicks'", expect: click('add 1 to field "Clicks"') },
  { prompt: "whenever I tap it, play a boing sound", expect: click('play boing "c4q"') },
  { prompt: "each time you press the button go to the next card", expect: click("go next") },
  { prompt: "after a click, go back", expect: click("go back") },
  { prompt: "when I hit it, beep", expect: click('play square8bit "a5e"') },
  { prompt: "when the pointer moves over this button, hilite it", expect: on("mouseEnter", "set the hilite of me to true") },
  { prompt: "when the mouse moves off it, unhilite me", expect: on("mouseLeave", "set the hilite of me to false") },
  { prompt: "whenever the mouse hovers over the button, show field 'Tip'", expect: on("mouseEnter", 'set the visible of field "Tip" to true') },
  { prompt: "every time the mouse enters, play a click sound", expect: on("mouseEnter", 'play click "c4q"') },
  { prompt: "every time the cursor leaves this button, hide field 'Tip'", expect: on("mouseLeave", 'set the visible of field "Tip" to false') },
  { prompt: "whenever the card opens, put the time into field 'Clock'", kind: "card", expect: on("openCard", 'put the time into field "Clock"') },
  { prompt: "each time the stack opens, go to the first card", kind: "stack", expect: on("openStack", "go first") },
  { prompt: "each time someone clicks here, beep twice", expect: click("repeat 2 times", '  play square8bit "a5e"', "  wait 15 ticks", "end repeat") },
  { prompt: "whenever it's pressed, go to the previous card", expect: click("go prev") },
  { prompt: "on every tap, play a click sound", expect: click('play click "c4q"') },
  { prompt: "every time I click, add 1 to field Count", expect: click('add 1 to field "Count"') },
  { prompt: "when the cursor rolls onto the button, show field 'Help'", expect: on("mouseEnter", 'set the visible of field "Help" to true') },
  { prompt: "when I stop hovering over it, hide field 'Help'", expect: on("mouseLeave", 'set the visible of field "Help" to false') },
  { prompt: "every time the card closes, put empty into field 'Note'", kind: "card", expect: on("closeCard", 'put empty into field "Note"') },
  { prompt: "when the mouse is over the button, hilite it", expect: on("mouseEnter", "set the hilite of me to true") },
  // must refuse: timers are no click trigger; movement without "over"; "while hovering" is a state;
  // a trigger article completed by the action ("the next card")
  { prompt: "every 5 seconds go to the next card", expect: null },
  { prompt: "every second play a beep", expect: null },
  { prompt: "when the mouse moves, hilite this button", expect: null },
  { prompt: "while hovering, hilite this button", expect: null },
  { prompt: "when the mouse enters the next card, beep", expect: null },

  // ----- family 8: enable / disable / grey out / dim / (de)activate -----
  { prompt: "after one click, disable this button", expect: click("set the enabled of me to false") },
  { prompt: "grey out the Next button", expect: click('set the enabled of button "Next" to false') },
  { prompt: "gray this button out", expect: click("set the enabled of me to false") },
  { prompt: "dim me", expect: click("set the enabled of me to false") },
  { prompt: "deactivate button B", expect: click('set the enabled of button "B" to false') },
  { prompt: "enable the Submit button", expect: click('set the enabled of button "Submit" to true') },
  { prompt: "activate it", expect: click("set the enabled of me to true") },
  { prompt: "re-enable button 'Next' when the card opens", kind: "card", expect: on("openCard", 'set the enabled of button "Next" to true') },
  { prompt: "disable this field", kind: "field", expect: click("set the enabled of me to false") },
  { prompt: "disable button 'Go' and enable button 'Stop'", expect: click('set the enabled of button "Go" to false', 'set the enabled of button "Stop" to true') },
  { prompt: "disable me", expect: click("set the enabled of me to false") },
  { prompt: "deactivate the 'Buy' button", expect: click('set the enabled of button "Buy" to false') },
  { prompt: "grey out button 'Save' when the card opens", kind: "card", expect: on("openCard", 'set the enabled of button "Save" to false') },
  { prompt: "every time this button is clicked, disable it", expect: click("set the enabled of me to false") },
  { prompt: "enable field 'Notes'", expect: click('set the enabled of field "Notes" to true') },
  { prompt: "make this button disabled", expect: click("set the enabled of me to false") },
  { prompt: "dim the Exit button", expect: click('set the enabled of button "Exit" to false') },
  // must refuse: cards and stacks have no enabled property; "this button" in a card script; unknown object
  { prompt: "disable the card", expect: null },
  { prompt: "deactivate this stack", kind: "stack", expect: null },
  { prompt: "deactivate me", kind: "card", expect: null },
  { prompt: "dim the lights", expect: null },

  // ===== Fourth rework: ambiguous unquoted value words =====
  // An unquoted word that becomes a text (put value, answer / ask text and buttons, comparison
  // operand, set the name / title value) is refused when it is a counter word or is also a field,
  // button or card name in the same prompt. Name slots are not affected.

  // must refuse: counter words, a word that is also a name, multi-word values, a button label
  { prompt: "put Score into field Total", expect: null },
  { prompt: "put Lives into field Status", expect: null },
  { prompt: "answer Points", expect: null },
  { prompt: "put Hello into field Hello and go to the next card", expect: null },
  { prompt: "if field Answer = Score then go next", expect: null },
  { prompt: "put Total Score into field Status", expect: null },
  { prompt: "show a message saying Game Over and go to card Game Over", expect: null },
  { prompt: "answer 'Ready?' with Gold or Silver", expect: null },
  { prompt: "set my name to High Score", expect: null },
  // must compile: quoted values, counter words as names, English counter phrases
  { prompt: "put 'Score' into field 'Total'", expect: click('put "Score" into field "Total"') },
  { prompt: "answer 'Score'", expect: click('answer "Score"') },
  { prompt: "put field Score into field Total", expect: click('put field "Score" into field "Total"') },
  { prompt: "put Welcome into field Greeting", expect: click('put "Welcome" into field "Greeting"') },
  { prompt: "put Hello into field Score", expect: click('put "Hello" into field "Score"') },
  { prompt: "add 1 to field Score", expect: click('add 1 to field "Score"') },
  { prompt: "go to card Lives", expect: click('go to card "Lives"') },
  { prompt: "put 0 into the Score field", expect: click('put 0 into field "Score"') },
  { prompt: "increase the score by 5", expect: click('add 5 to field "score"') },
  { prompt: "add 3 to lives", expect: click('add 3 to field "lives"') },
  { prompt: "if field Lives is less than 1 then go to card Lives", expect: click('if field "Lives" < 1 then go to card "Lives"') },
  { prompt: "show a message saying You win and go to card Score", expect: click('answer "You win"', 'go to card "Score"') },

  // ----- not understood: out of scope, ambiguous or incomplete -----
  { prompt: "make the game harder every level", expect: null },
  { prompt: "sort the cards alphabetically", expect: null },
  { prompt: "send an email to my friend", expect: null },
  { prompt: "play my favorite song from spotify", expect: null },
  { prompt: "dissolve", expect: null },
  { prompt: "wipe to the next card", expect: null },
  { prompt: "go to the next card and then come back", expect: null },
  { prompt: "when clicked go to the next card and when the card opens play a sound", expect: null },
  { prompt: "show the score", expect: null },
  { prompt: "say the score", expect: null },
  { prompt: "put the score into field 'Total'", expect: null },
  { prompt: "repeat forever", expect: null },
];
