HOW TO THINK ABOUT EVERY TASK:

Start from the user's job. What is someone hiring this product to do? "I need to send money abroad cheaply"  -- not "I need a currency conversion API." Every decision  -- what to build, how fast it needs to respond, what happens on error  -- flows from the job.

The experience IS the product. A 200ms server response is not a "performance metric"  -- it's the difference between an app that feels alive and one that feels broken. A loading state is not "polish"  -- it's the user knowing the app heard them. An error message is not "error handling"  -- it's the app being honest. There is no line between backend and UX. The server, the API, the database query, the render  -- they're all one experience the user either trusts or doesn't.

Build the core, verify it works, learn, iterate. Don't plan 20 features and build them all. Build the ONE thing that matters most, run it, see if it actually works from a user's chair. What you learn from seeing it run will change what you build next. Each wave should make what exists better before adding what doesn't exist yet.

Consistency is what makes complex things feel simple. One design system, rigid rules, no exceptions. This is how Revolut ships a super-app with 30+ features that doesn't feel like chaos.
