# External Management API

This API lets your backend send data into Pol.is and read useful Pol.is results back out.

Use it from your server. Do not call it from a browser, because it uses a secret API key.

## Basic Setup

Set these environment variables on the Pol.is server:

```bash
EXTERNAL_API_KEY=make-this-a-long-random-secret
EXTERNAL_API_OWNER_USER_ID=123
MATH_ENV=prod
```

`EXTERNAL_API_OWNER_USER_ID` is the Pol.is user ID that will own the conversations created by this API.

That user must already exist in the Pol.is database.

`EXTERNAL_API_OWNER_UID` also works as an alias.

`MATH_ENV` must be the same for the web dyno and the worker dyno. Usually use `prod` on Heroku.

Every request must send this header:

```http
Authorization: Bearer make-this-a-long-random-secret
```

In the examples below:

```bash
POLIS_URL=https://your-polis-server.example.com
API_KEY=make-this-a-long-random-secret
```

## Important Names

Pol.is uses a few names that are easy to mix up:

`conversationId`
: The public Pol.is conversation ID. This is safe to store in your app.

`externalParticipantId`
: Your user ID from your own system. Pol.is stores it as an XID.

`statementId`
: The Pol.is statement/comment ID. Pol.is calls this `tid` internally.

`vote`
: The vote value for one user on one statement.

Vote values are:

```text
-1 = agree
 0 = pass
 1 = disagree
```

## Normal Flow

1. Create a Pol.is conversation.
2. Send user comments into that conversation.
3. Send user votes into that conversation.
4. Pol.is automatically queues math refresh work.
5. Read insight endpoints and show them in your UI.

The API write calls stay fast. The expensive Pol.is math runs in the background worker.

If `mathRefreshQueued` is `false`, it usually means there is already a recent pending refresh for that conversation. That is okay.

## Create A Conversation

```bash
curl -X POST "$POLIS_URL/api/v3/external/conversations" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Should we change the city transport plan?",
    "description": "A conversation imported from our app.",
    "isActive": true,
    "isDraft": false
  }'
```

Response:

```json
{
  "conversationId": "abc123def",
  "url": "https://your-polis-server.example.com/abc123def"
}
```

Save `conversationId` in your own database.

Optional fields:

```json
{
  "conversationId": "my-own-id",
  "strictModeration": false,
  "profanityFilter": true,
  "spamFilter": true,
  "isDataOpen": false,
  "useExternalParticipantIdAllowlist": false,
  "externalParticipantIdRequired": true
}
```

## Add A Comment

Use this when a user in your app writes a comment.

```bash
curl -X POST "$POLIS_URL/api/v3/external/conversations/abc123def/comments" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "externalParticipantId": "user_42",
    "text": "Buses should run more often at night."
  }'
```

Response:

```json
{
  "conversationId": "abc123def",
  "externalParticipantId": "user_42",
  "participantId": 7,
  "statementId": 3,
  "mathRefreshQueued": true
}
```

Save `statementId` if you want to link your comment to the Pol.is statement.

Pol.is automatically queues a background math refresh after the comment is saved.

You can also add a vote from the comment author at the same time:

```json
{
  "externalParticipantId": "user_42",
  "text": "Buses should run more often at night.",
  "vote": -1
}
```

## Add Or Change One Vote

Use this when one user votes on one statement.

```bash
curl -X POST "$POLIS_URL/api/v3/external/conversations/abc123def/votes" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "externalParticipantId": "user_99",
    "statementId": 3,
    "vote": -1
  }'
```

Response:

```json
{
  "conversationId": "abc123def",
  "externalParticipantId": "user_99",
  "participantId": 8,
  "statementId": 3,
  "vote": -1,
  "mathRefreshQueued": true
}
```

If the same user votes again on the same statement, Pol.is keeps the latest vote.

Pol.is automatically queues a background math refresh after the vote is saved.

Optional fields:

```json
{
  "highPriority": true,
  "starred": true
}
```

## Add Many Votes

Use this for small batches. The limit is 500 votes per request.

```bash
curl -X POST "$POLIS_URL/api/v3/external/conversations/abc123def/votes/batch" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "votes": [
      {
        "externalParticipantId": "user_99",
        "statementId": 3,
        "vote": -1
      },
      {
        "externalParticipantId": "user_100",
        "statementId": 3,
        "vote": 1
      }
    ]
  }'
```

Response:

```json
{
  "conversationId": "abc123def",
  "mathRefreshQueued": true,
  "results": [
    {
      "status": "success",
      "externalParticipantId": "user_99",
      "statementId": 3,
      "participantId": 8
    },
    {
      "status": "success",
      "externalParticipantId": "user_100",
      "statementId": 3,
      "participantId": 9
    }
  ]
}
```

One bad vote does not stop the whole batch. Bad items return `"status": "error"`.

Pol.is automatically queues a background math refresh if at least one vote succeeds.

## Add A Conversation Upvote

This is a simple upvote for the whole conversation, not a vote on a statement.

```bash
curl -X POST "$POLIS_URL/api/v3/external/conversations/abc123def/upvotes" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "externalParticipantId": "user_42"
  }'
```

Response:

```json
{
  "conversationId": "abc123def",
  "externalParticipantId": "user_42",
  "upvoted": true
}
```

If the same user upvotes again, the response is still safe:

```json
{
  "conversationId": "abc123def",
  "externalParticipantId": "user_42",
  "upvoted": true,
  "duplicate": true
}
```

## How Pol.is Refreshes Math

You usually do not need to call a refresh endpoint.

When this API receives a new comment or vote, Pol.is queues a background math refresh for that conversation.

The refresh is debounced. If many comments or votes arrive quickly, Pol.is will not create a new math task for every single write.

Pol.is keeps one pending automatic math task per conversation. During a burst, it will touch that pending task at most once every 30 seconds.

This keeps normal writes fast, while still letting the math worker update the insights in the background.

The math worker must be running for insights to update. On Heroku, this means the `worker` dyno must be scaled up.

```bash
heroku ps:scale web=1 worker=1 -a your-heroku-app
```

If the worker is off, comments and votes can still be saved. The insight endpoints may stay stale, and `mathReady` may stay `false`.

After comments or votes are written, poll the status endpoint until `mathReady` is `true`.

## Heroku Worker Memory

The web dyno handles API requests.

The worker dyno runs the expensive Pol.is math.

After deploying this version, run the database migrations again. The new migration keeps the math refresh queue from growing without limit.

If that migration has not run, automatic math refresh queueing will not work correctly.

For the cheapest first smoke test, you can run only the web dyno:

```bash
heroku ps:scale web=1 worker=0 -a your-heroku-app
```

That proves conversation, comment, and vote writes work. It does not update math insights.

No extra memory config is required for normal use. The worker defaults to using 65% of dyno memory for Java heap and leaves room for the rest of the process.

Turn the worker on when you want math insights:

```bash
heroku ps:scale web=1 worker=1 -a your-heroku-app
```

If you see Heroku `R15` memory errors, do not scale blindly. First lower memory pressure or use a bigger worker dyno.

The only worker memory setting you normally might change is `MATH_JVM_OPTS`.

For a small dyno, try a fixed smaller heap:

```bash
heroku config:set MATH_JVM_OPTS="-J-Xmx384m -J-XX:+ExitOnOutOfMemoryError" -a your-heroku-app
```

For a larger worker dyno, you can allow more heap:

```bash
heroku config:set MATH_JVM_OPTS="-J-Xmx768m -J-XX:+ExitOnOutOfMemoryError" -a your-heroku-app
```

To go back to the safe default:

```bash
heroku config:unset MATH_JVM_OPTS -a your-heroku-app
```

## Conversation Size Limits

Pol.is math gets more expensive as conversations get bigger.

For your setup, your own backend is the main app, and Pol.is is the insight engine. Keep each mirrored Pol.is conversation bounded.

The defaults are `100000` participants and `10000` statements/comments per conversation.

You do not need to set these on Heroku unless you want lower limits.

Simple meaning:

`MATH_CUTOFF_MAX_PTPTS`
: Maximum participants the math worker will keep in one conversation.

`MATH_CUTOFF_MAX_CMNTS`
: Maximum statements/comments the math worker will keep in one conversation.

For early testing, you can use smaller numbers so mistakes are cheap:

```bash
heroku config:set \
  MATH_CUTOFF_MAX_PTPTS=5000 \
  MATH_CUTOFF_MAX_CMNTS=1000 \
  -a your-heroku-app
```

These limits protect the math worker. They do not stop your own backend from storing more data in your own database.

## Manual Math Refresh

This endpoint is still available, but it is mostly for debugging, manual repair, or forcing a refresh after a special import.

Normal backend code should not need it.

It adds a background job. It does not return the final math immediately.

```bash
curl -X POST "$POLIS_URL/api/v3/external/conversations/abc123def/insights/refresh" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response:

```json
{
  "conversationId": "abc123def",
  "status": "queued",
  "mathUpdateType": "update"
}
```

After this, poll the status endpoint until `mathReady` is `true`.

## Read Status

Use this to check if math is ready.

```bash
curl "$POLIS_URL/api/v3/external/conversations/abc123def/insights/status" \
  -H "Authorization: Bearer $API_KEY"
```

Response:

```json
{
  "conversationId": "abc123def",
  "topic": "Should we change the city transport plan?",
  "participantCount": 120,
  "statementCount": 18,
  "voteCount": 1400,
  "upvoteCount": 20,
  "lastVoteTimestamp": 1760000000000,
  "lastStatementTimestamp": 1760000000000,
  "mathReady": true,
  "mathTick": 12,
  "groupCount": 3,
  "hasGroups": true
}
```

## Read Statement Insights

Use this to show useful statement-level data in your UI.

```bash
curl "$POLIS_URL/api/v3/external/conversations/abc123def/insights/statements?sort=divisive&limit=10" \
  -H "Authorization: Bearer $API_KEY"
```

Useful sort values:

```text
tid
votes
consensus
divisive
uncertainty
extremity
```

Response:

```json
{
  "conversationId": "abc123def",
  "mathReady": true,
  "mathTick": 12,
  "groupCount": 3,
  "hasGroups": true,
  "statements": [
    {
      "statementId": 3,
      "text": "Buses should run more often at night.",
      "active": true,
      "moderationStatus": 0,
      "authorExternalParticipantId": "user_42",
      "voteCount": 100,
      "agreeCount": 60,
      "disagreeCount": 30,
      "passCount": 10,
      "agreement": 0.6,
      "disagreement": 0.3,
      "pass": 0.1,
      "consensusScore": 0.6,
      "divisivenessScore": 0.333333,
      "uncertaintyScore": 0.1,
      "majority": "agree",
      "groupAwareConsensus": 0.72,
      "commentExtremity": 0.44,
      "groupStats": {
        "0": {
          "voteCount": 40,
          "agreeCount": 30,
          "disagreeCount": 5,
          "passCount": 5,
          "agreement": 0.75,
          "disagreement": 0.125,
          "pass": 0.125
        }
      }
    }
  ]
}
```

Simple meaning:

`consensusScore`
: How strongly the statement has one clear winning side.

`divisivenessScore`
: How split agree and disagree voters are. Higher means more split.

`uncertaintyScore`
: How often people passed.

`groupAwareConsensus`
: Pol.is consensus score that accounts for opinion groups.

`commentExtremity`
: How far this statement sits in the opinion space.

## Read Group Insights

Use this to show Pol.is opinion groups.

```bash
curl "$POLIS_URL/api/v3/external/conversations/abc123def/insights/groups" \
  -H "Authorization: Bearer $API_KEY"
```

Response:

```json
{
  "conversationId": "abc123def",
  "mathReady": true,
  "mathTick": 12,
  "groupCount": 3,
  "hasGroups": true,
  "groups": [
    {
      "groupId": "0",
      "center": [0.12, -0.33],
      "participantCount": 45,
      "externalParticipantIds": ["user_42", "user_99"],
      "unmappedParticipantCount": 0,
      "representativeStatements": [
        {
          "statementId": 3,
          "text": "Buses should run more often at night.",
          "voteCount": 100,
          "agreeCount": 60,
          "disagreeCount": 30,
          "passCount": 10,
          "score": 0.88
        }
      ],
      "topAgreeStatements": [],
      "topDisagreeStatements": []
    }
  ]
}
```

If you do not need group member IDs, use:

```bash
curl "$POLIS_URL/api/v3/external/conversations/abc123def/insights/groups?includeParticipants=false" \
  -H "Authorization: Bearer $API_KEY"
```

## Read Overview

Use this for one simple UI call.

```bash
curl "$POLIS_URL/api/v3/external/conversations/abc123def/insights/overview" \
  -H "Authorization: Bearer $API_KEY"
```

Response includes:

```text
status counts
top consensus statements
top divisive statements
top uncertain statements
group summaries
```

## Error Responses

Missing or wrong API key:

```json
{
  "error": "polis_err_external_api_auth"
}
```

Unknown conversation:

```json
{
  "error": "polis_err_unknown_conversation"
}
```

Bad input:

```json
{
  "error": "polis_err_param_invalid_vote"
}
```

## Best Way To Use This With Your App

Your app should stay the source of truth.

Store these links in your own database:

```text
your conversation id -> Pol.is conversationId
your user id         -> externalParticipantId
your comment id      -> Pol.is statementId
```

Send comments and votes to Pol.is when they happen in your app.

Pol.is queues math refresh work automatically after comments and votes.

Then read the insight endpoints and show the results in your frontend.
