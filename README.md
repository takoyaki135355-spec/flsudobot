# Sudobot 
**Current Version**
V2.5.0
---
## Capabilities

- AI chatbot powered by Groq's Llama 3.3 70B model (hey sudobot <prompt> or mention the bot)
- Persistent homework manager with !add, !show, and !remove
- Owner-only DM command system
- Remote DM sender (!send) capable of messaging users by ID, mention, or username
- Megaphone mode that can discover and list every reachable channel and DM
- Remote message relay that lets you send messages into any selected channel from your owner DM
- Echo mode for testing and debugging replies
- Detailed logging of outgoing messages, AI responses, megaphone activity, and commands
- Startup notifications sent directly to the owner
- Graceful shutdown commands (!QUIT, Ctrl+C handling)
- Automatic crash detection for uncaught exceptions and rejected promises
- Error reporting through a dedicated log channel
- Permission-aware channel discovery that only shows channels the bot can actually use
- Persistent JSON-based storage that survives restarts
- Environment-variable configuration for secure token and ID management
- Works across servers and DMs simultaneously
- Built-in custom responses, inside jokes, and random yes/no decision making
- Poll Functionality via reactions, limiting reactions/user to 1
---
## Patch Notes:

2.5.0   Integrated Poll Feature

2.4.10  Integrated Artificial Intellegence
