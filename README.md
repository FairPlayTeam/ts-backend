# fairplay ts api

ik the devs are really wanting rust but i was bored and made this api

this is like 90% done it uses jwt minio postgres express.js ffmpeg typescript and prisma with bun

its actually pretty fast docs are on /docs but also here

just use this api ffs 🥺

to set this up download bun from https://bun.sh

run `bun i` to install make .env from example then `bunx prisma generate` to gen the prisma `bunx prisma db push` to push schema to db then `bun run dev` to dev for prod `bun run build` then `bun run start`

api docs

```json
{
  "name": "fpbackend API",
  "version": "1.0.0",
  "routes": [
    {
      "method": "GET",
      "path": "/health",
      "summary": "Health check",
      "responses": {
        "200": "{ \"status\": \"ok\", \"timestamp\": \"ISO8601\", \"uptime\": 123.45 }"
      }
    },
    {
      "method": "GET",
      "path": "/stream/videos/:userId/:videoId/master.m3u8",
      "summary": "Proxy HLS master playlist",
      "description": "Backend proxy for HLS master playlist. Consumed by players; usually not called directly by users."
    },
    {
      "method": "GET",
      "path": "/stream/videos/:userId/:videoId/:quality/index.m3u8",
      "summary": "Proxy HLS variant playlist"
    },
    {
      "method": "GET",
      "path": "/stream/videos/:userId/:videoId/:quality/:segment",
      "summary": "Proxy HLS segment (.ts)"
    },
    {
      "method": "GET",
      "path": "/docs",
      "summary": "List API documentation",
      "responses": {
        "200": "{ \"name\": \"fpbackend API\", \"version\": \"1.0.0\", \"routes\": [ ... ] }"
      }
    },
    {
      "method": "GET",
      "path": "/user/:id",
      "summary": "Get a public user profile by id",
      "params": {
        "id": "User ID"
      },
      "responses": {
        "200": "{\n  \"id\": \"string\",\n  \"username\": \"string\",\n  \"displayName\": \"string|null\",\n  \"avatarUrl\": \"string|null\",\n  \"bannerUrl\": \"string|null\",\n  \"bio\": \"string|null\",\n  \"followerCount\": 0,\n  \"followingCount\": 0,\n  \"videoCount\": 0,\n  \"createdAt\": \"ISO8601\"\n}",
        "404": "{ \"error\": \"User not found\" }"
      }
    },
    {
      "method": "GET",
      "path": "/user/:id/videos",
      "summary": "List a user's public videos",
      "params": {
        "id": "User ID"
      },
      "query": {
        "page": "number (default 1)",
        "limit": "number (default 20)"
      },
      "responses": {
        "200": "{\n  \"videos\": [\n    { \"id\": \"string\", \"title\": \"string\", \"description\": \"string|null\", \"createdAt\": \"ISO8601\", \"viewCount\": \"string\", \"thumbnailUrl\": \"string|null\" }\n  ],\n  \"pagination\": { \"page\": 1, \"limit\": 20, \"total\": 10 }\n}"
      }
    },
    {
      "method": "GET",
      "path": "/user/:id/followers",
      "summary": "Get a user's followers",
      "params": {
        "id": "User ID"
      },
      "query": {
        "page": "number (default 1)",
        "limit": "number (default 20)"
      },
      "responses": {
        "200": "{\n  \"followers\": [\n    { \"id\": \"string\", \"username\": \"string\", \"displayName\": \"string|null\", \"avatarUrl\": \"string|null\" }\n  ],\n  \"pagination\": { \"page\": 1, \"limit\": 20, \"total\": 100 }\n}"
      }
    },
    {
      "method": "GET",
      "path": "/user/:id/following",
      "summary": "Get users someone is following",
      "params": {
        "id": "User ID"
      },
      "query": {
        "page": "number (default 1)",
        "limit": "number (default 20)"
      },
      "responses": {
        "200": "{\n  \"following\": [\n    { \"id\": \"string\", \"username\": \"string\", \"displayName\": \"string|null\", \"avatarUrl\": \"string|null\" }\n  ],\n  \"pagination\": { \"page\": 1, \"limit\": 20, \"total\": 100 }\n}"
      }
    },
    {
      "method": "POST",
      "path": "/user/:id/follow",
      "summary": "Follow a user",
      "auth": true,
      "params": {
        "id": "User ID to follow"
      },
      "responses": {
        "204": "Success",
        "409": "Already following"
      }
    },
    {
      "method": "DELETE",
      "path": "/user/:id/follow",
      "summary": "Unfollow a user",
      "auth": true,
      "params": {
        "id": "User ID to unfollow"
      },
      "responses": {
        "204": "Success",
        "404": "Not following"
      }
    },
    {
      "method": "POST",
      "path": "/auth/register",
      "summary": "Register a new user",
      "body": {
        "email": "string",
        "username": "string",
        "password": "string"
      },
      "responses": {
        "201": "User registered with JWT token"
      }
    },
    {
      "method": "POST",
      "path": "/auth/login",
      "summary": "Login user",
      "body": {
        "emailOrUsername": "string",
        "password": "string"
      },
      "responses": {
        "200": "User logged in with JWT token"
      }
    },
    {
      "method": "GET",
      "path": "/auth/me",
      "summary": "Get current user profile",
      "auth": true,
      "responses": {
        "200": "User profile"
      }
    },
    {
      "method": "PATCH",
      "path": "/auth/me",
      "summary": "Update current user profile",
      "auth": true,
      "body": {
        "displayName": "string (optional)",
        "bio": "string (optional)"
      },
      "responses": {
        "200": "{ \"message\": \"Profile updated successfully\", ... }"
      }
    },
    {
      "method": "GET",
      "path": "/",
      "summary": "API root: overview and endpoints",
      "responses": {
        "200": "{ \"message\": \"fpbackend\", \"version\": \"x.x.x\", \"docs\": \"/docs\"}"
      }
    },
    {
      "method": "POST",
      "path": "/upload/video",
      "summary": "Upload a video (queued for processing)",
      "auth": true,
      "body": {
        "title": "string",
        "description": "string?",
        "tags": "string (comma-separated)",
        "video": "file"
      },
      "responses": {
        "200": "{\n  \"message\": \"Video uploaded successfully and queued for processing\",\n  \"video\": {\n    \"id\": \"string\",\n    \"title\": \"string\"\n  }\n}"
      }
    },
    {
      "method": "POST",
      "path": "/upload/avatar",
      "summary": "Upload user avatar",
      "auth": true,
      "body": {
        "avatar": "image file"
      },
      "responses": {
        "200": "{\n  \"message\": \"Avatar uploaded successfully\",\n  \"storagePath\": \"string\",\n  \"size\": 12345,\n  \"mimetype\": \"image/png\"\n}"
      }
    },
    {
      "method": "POST",
      "path": "/upload/banner",
      "summary": "Upload user banner",
      "auth": true,
      "body": {
        "banner": "image file"
      },
      "responses": {
        "200": "{\n  \"message\": \"Banner uploaded successfully\",\n  \"storagePath\": \"string\",\n  \"size\": 12345,\n  \"mimetype\": \"image/png\"\n}"
      }
    },
    {
      "method": "GET",
      "path": "/upload/url/:bucket/:filename",
      "summary": "Get presigned URL for object",
      "auth": true,
      "params": {
        "bucket": "videos|users",
        "filename": "string"
      },
      "responses": {
        "200": "{ \"url\": \"string\", \"expiresIn\": 86400 }"
      }
    },
    {
      "method": "POST",
      "path": "/comments/:commentId/like",
      "summary": "Like a comment",
      "auth": true,
      "params": {
        "commentId": "Comment ID"
      },
      "responses": {
        "201": "{ \"message\": \"Comment liked\", \"likeCount\": 1 }",
        "404": "{ \"error\": \"Comment not found\" }",
        "409": "{ \"error\": \"Comment already liked\" }"
      }
    },
    {
      "method": "DELETE",
      "path": "/comments/:commentId/like",
      "summary": "Unlike a comment",
      "auth": true,
      "params": {
        "commentId": "Comment ID"
      },
      "responses": {
        "200": "{ \"message\": \"Comment unliked\", \"likeCount\": 0 }",
        "404": "{ \"error\": \"Like not found for this comment\" }"
      }
    },
    {
      "method": "GET",
      "path": "/videos",
      "summary": "List publicly available videos",
      "description": "Returns only videos that are approved, done processing, and public.",
      "query": {
        "page": "number (default 1)",
        "limit": "number (default 20)"
      },
      "responses": {
        "200": "{\n  \"videos\": [\n    {\n      \"id\": \"string\",\n      \"title\": \"string\",\n      \"thumbnailUrl\": \"string|null\",\n      \"viewCount\": \"string\",\n      \"avgRating\": 4.5,\n      \"ratingsCount\": 10,\n      \"user\": { \"username\": \"string\", \"displayName\": \"string|null\" }\n    }\n  ],\n  \"pagination\": { \"page\": 1, \"limit\": 20, \"total\": 100 }\n}"
      }
    },
    {
      "method": "GET",
      "path": "/videos/my",
      "summary": "List my videos",
      "auth": true,
      "query": {
        "page": "number (default 1)",
        "limit": "number (default 20)"
      },
      "responses": {
        "200": "{\n  \"videos\": [\n    {\n      \"id\": \"string\",\n      \"title\": \"string\",\n      \"thumbnailUrl\": \"string|null\",\n      \"viewCount\": \"string\",\n      \"avgRating\": 4.5,\n      \"ratingsCount\": 10\n    }\n  ],\n  \"pagination\": { \"page\": 1, \"limit\": 20, \"total\": 100 }\n}"
      }
    },
    {
      "method": "GET",
      "path": "/videos/search",
      "summary": "Search publicly available videos",
      "description": "Search only videos that are approved, done processing, public, and whose owners are not banned.",
      "query": {
        "q": "string (query term)",
        "page": "number (default 1)",
        "limit": "number (default 20)"
      },
      "responses": {
        "200": "{\n  \"videos\": [\n    { \"id\": \"string\", \"title\": \"string\", \"thumbnailUrl\": \"string|null\", \"viewCount\": \"string\", \"avgRating\": 4.5, \"ratingsCount\": 10, \"user\": { \"username\": \"string\", \"displayName\": \"string|null\" }, \"createdAt\": \"ISO8601\" }\n  ],\n  \"pagination\": { \"page\": 1, \"limit\": 20, \"total\": 100 },\n  \"query\": { \"q\": \"term\" }\n}"
      }
    },
    {
      "method": "GET",
      "path": "/videos/:id",
      "summary": "Get video details",
      "params": {
        "id": "Video ID"
      },
      "responses": {
        "200": "{\n  \"id\": \"string\",\n  \"title\": \"string\",\n  \"hls\": {\n    \"master\": \"string|null\",\n    \"variants\": {\n      \"240p\": \"string|null\",\n      \"480p\": \"string|null\",\n      \"720p\": \"string|null\",\n      \"1080p\": \"string|null\"\n    },\n    \"available\": [\"1080p\",\"720p\"],\n    \"preferred\": \"1080p\"\n  },\n  \"thumbnailUrl\": \"string|null\",\n  \"viewCount\": \"string\",\n  \"avgRating\": 4.5,\n  \"ratingsCount\": 10\n}",
        "403": "{ \"error\": \"Video not available\" }",
        "404": "{ \"error\": \"Video not found\" }"
      }
    },
    {
      "method": "PATCH",
      "path": "/videos/:id",
      "summary": "Update video details",
      "description": "Update the title, description, or visibility of a video. Only the video owner can perform this action.",
      "auth": true,
      "params": {
        "id": "Video ID"
      },
      "body": {
        "title": "string (optional)",
        "description": "string (optional)",
        "visibility": "public | unlisted | private (optional)"
      },
      "responses": {
        "200": "{ \"message\": \"Video updated successfully\", \"video\": { ..., \"thumbnailUrl\": \"string|null\" } }",
        "403": "{ \"error\": \"You are not authorized to edit this video\" }",
        "404": "{ \"error\": \"Video not found\" }"
      }
    },
    {
      "method": "POST",
      "path": "/videos/:id/thumbnail",
      "summary": "Update video thumbnail",
      "description": "Upload a new thumbnail for a video. Only the video owner can perform this action.",
      "auth": true,
      "params": {
        "id": "Video ID"
      },
      "body": {
        "thumbnail": "image file"
      },
      "responses": {
        "200": "{ \"message\": \"Thumbnail updated successfully\", \"thumbnailUrl\": \"string|null\" }",
        "400": "{ \"error\": \"No thumbnail file provided\" }",
        "403": "{ \"error\": \"You are not authorized to edit this video\" }",
        "404": "{ \"error\": \"Video not found\" }"
      }
    },
    {
      "method": "POST",
      "path": "/videos/:videoId/rating",
      "summary": "Rate a video",
      "auth": true,
      "params": {
        "videoId": "Video ID"
      },
      "body": {
        "score": "number (1-5)"
      },
      "responses": {
        "200": "{ \"message\": \"Rating updated\", ... }",
        "201": "{ \"message\": \"Rating created\", ... }",
        "404": "{ \"error\": \"Video not found\" }"
      }
    },
    {
      "method": "POST",
      "path": "/videos/:videoId/comments",
      "summary": "Add a comment to a video",
      "description": "To reply to another comment, include the `parentId` of the comment you are replying to in the request body.",
      "auth": true,
      "params": {
        "videoId": "Video ID"
      },
      "body": {
        "content": "string (1-1000 chars)",
        "parentId": "string (optional UUID)"
      },
      "responses": {
        "201": "{ \"message\": \"Comment added\", ... }",
        "404": "{ \"error\": \"Video not found\" }"
      }
    },
    {
      "method": "GET",
      "path": "/videos/:videoId/comments",
      "summary": "Get comments for a video",
      "description": "Returns comments in a nested structure. The top-level array contains only parent comments. Replies are included in the `replies` array of each comment object.",
      "params": {
        "videoId": "Video ID"
      },
      "query": {
        "page": "number (default 1)",
        "limit": "number (default 20)"
      },
      "responses": {
        "200": "{\n  \"comments\": [\n    {\n      \"id\": \"string\",\n      \"content\": \"string\",\n      \"createdAt\": \"ISO8601\",\n      \"user\": { \"id\": \"string\", \"username\": \"string\", ... },\n      \"replies\": [\n        {\n          \"id\": \"string\",\n          \"content\": \"This is a reply.\",\n          \"createdAt\": \"ISO8601\",\n          \"user\": { \"id\": \"string\", \"username\": \"string\", ... },\n          \"replies\": []\n        }\n      ]\n    }\n  ],\n  \"pagination\": { \"page\": 1, \"limit\": 20, \"total\": 100 }\n}"
      }
    },
    {
      "method": "GET",
      "path": "/admin/users",
      "summary": "Admin: list users",
      "description": "Lists users with optional search and ban filtering. Supports pagination and sorting.",
      "auth": true,
      "roles": ["admin"],
      "query": {
        "search": "Search in username/email/displayName (optional)",
        "isBanned": "true|false (optional)",
        "page": "Page number (default 1)",
        "limit": "Items per page (default 20)",
        "sort": "field:dir (default createdAt:desc)"
      },
      "responses": {
        "200": "{\n  \"users\": [\n    {\n      \"id\": \"string\",\n      \"email\": \"string\",\n      \"username\": \"string\",\n      \"displayName\": \"string|null\",\n      \"role\": \"user|moderator|admin\",\n      \"isActive\": true,\n      \"isVerified\": false,\n      \"isBanned\": false,\n      \"banReasonPublic\": \"string|null\",\n      \"createdAt\": \"ISO8601\"\n    }\n  ],\n  \"pagination\": { \"page\": 1, \"limit\": 20, \"total\": 123 }\n}"
      }
    },
    {
      "method": "GET",
      "path": "/admin/users/:id",
      "summary": "Admin: get user by id",
      "auth": true,
      "roles": ["admin"],
      "params": {
        "id": "User ID"
      },
      "responses": {
        "200": "{\n  \"id\": \"string\",\n  \"email\": \"string\",\n  \"username\": \"string\",\n  \"displayName\": \"string|null\",\n  \"role\": \"user|moderator|admin\",\n  \"isActive\": true,\n  \"isVerified\": false,\n  \"isBanned\": false,\n  \"banReasonPublic\": \"string|null\",\n  \"banReasonPrivate\": \"string|null\",\n  \"bannedAt\": \"ISO8601|null\",\n  \"createdAt\": \"ISO8601\",\n  \"followerCount\": 0,\n  \"followingCount\": 0,\n  \"videoCount\": 0,\n  \"totalViews\": \"string\"\n}",
        "404": "{ \"error\": \"User not found\" }"
      }
    },
    {
      "method": "PATCH",
      "path": "/admin/users/:id/role",
      "summary": "Admin: update user role",
      "auth": true,
      "roles": ["admin"],
      "params": {
        "id": "User ID"
      },
      "body": {
        "role": "user | moderator | admin"
      },
      "responses": {
        "200": "{ \"message\": \"User role updated successfully\", ... }",
        "404": "{ \"error\": \"User not found\" }"
      }
    },
    {
      "method": "PATCH",
      "path": "/admin/users/:id/ban",
      "summary": "Admin: ban or unban a user",
      "description": "Ban or unban a user with optional public and private reasons. Sets bannedAt when banning.",
      "auth": true,
      "roles": ["admin"],
      "params": {
        "id": "User ID"
      },
      "body": {
        "isBanned": "boolean",
        "publicReason": "string?",
        "privateReason": "string?"
      },
      "responses": {
        "200": "{\n  \"message\": \"User banned|User unbanned\",\n  \"user\": {\n    \"id\": \"string\",\n    \"username\": \"string\",\n    \"isBanned\": true,\n    \"banReasonPublic\": \"string|null\",\n    \"banReasonPrivate\": \"string|null\",\n    \"bannedAt\": \"ISO8601|null\"\n  }\n}",
        "404": "{ \"error\": \"User not found\" }"
      }
    },
    {
      "method": "GET",
      "path": "/moderator/videos",
      "summary": "List videos for moderation",
      "description": "Lists videos with advanced filters. Supports filtering by processingStatus, moderationStatus, visibility, owner, and title search. Supports pagination and sorting.",
      "auth": true,
      "roles": ["moderator", "admin"],
      "query": {
        "processingStatus": "uploading|processing|done (optional)",
        "moderationStatus": "pending|approved|rejected (optional)",
        "visibility": "public|unlisted|private (optional)",
        "userId": "Filter by owner (optional)",
        "search": "Case-insensitive substring in title (optional)",
        "page": "Page number (default 1)",
        "limit": "Items per page (default 20)",
        "sort": "field:dir (default createdAt:desc)"
      },
      "responses": {
        "200": "{\n  \"videos\": [\n    {\n      \"id\": \"string\",\n      \"title\": \"string\",\n      \"user\": { \"id\": \"string\", \"username\": \"string\", \"displayName\": \"string|null\" },\n      \"thumbnailUrl\": \"string|null\",\n      \"processingStatus\": \"uploading|processing|done\",\n      \"moderationStatus\": \"pending|approved|rejected\",\n      \"visibility\": \"public|unlisted|private\",\n      \"createdAt\": \"ISO8601\"\n    }\n  ],\n  \"pagination\": { \"page\": 1, \"limit\": 20, \"total\": 123 }\n}"
      }
    },
    {
      "method": "PATCH",
      "path": "/moderator/videos/:id/moderation",
      "summary": "Approve or reject a video",
      "description": "Update only moderationStatus to approved or rejected for a video.",
      "auth": true,
      "roles": ["moderator", "admin"],
      "params": {
        "id": "Video ID"
      },
      "body": {
        "action": "'approve' | 'reject'"
      },
      "responses": {
        "200": "{\n  \"message\": \"Moderation updated\",\n  \"video\": {\n    \"id\": \"string\",\n    \"title\": \"string\",\n    \"moderationStatus\": \"approved|rejected\",\n    \"processingStatus\": \"uploading|processing|done\"\n  }\n}",
        "404": "{ \"error\": \"Video not found\" }"
      }
    }
  ]
}
```
