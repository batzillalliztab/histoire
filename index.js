const LOCALSTORAGE_USERS_KEY = "users";
const LOCALSTORAGE_USERS_LAST_ETAG_KEY = "users-last-etag";

// How long ago to look for log messages.
const LOOKBACK_SECONDS = 60 * 60 * 24 * 7 * 4; // 4 weeks
const ERA_SECONDS = 1000000;
const OLDEST_ERA = 1538000000;
const CURRENT_ERA_END = computeEra(Math.floor(Date.now() / 1000) + ERA_SECONDS);
const CURRENT_ERA_START = CURRENT_ERA_END - ERA_SECONDS;

const BASE_REPO = "batzillalliztab/histoire";

const ALL_USERS = "*";

// Testing facilities.
const TEST_USER = "test-user";
const TEST_CHANNEL = "#test-channel";
const TEST_USER_UPDATES = [
    {
        era: 42,
        when: Date.now() / 1000,
        user: TEST_USER,
        message: "Bug number test: bug 123",
        channel: "#test-channel",
    },
    {
        era: 43,
        when: Date.now() / 1000,
        user: TEST_USER,
        message: `Simple link test: https://github.com/${BASE_REPO}`,
        channel: "#test-other",
    },
    {
        era: 44,
        when: Date.now() / 1000,
        user: TEST_USER,
        message: `Multiple regexp matches with text after: https://github.com/${BASE_REPO}, bug 12345, text afterwards`,
        channel: "#test-channel",
    },
    {
        era: 45,
        when: Date.now() / 1000,
        user: TEST_USER,
        message:
            "Repository test: binjs-ref#334 (nonexistent repo: unknown#42)",
        channel: "#test-channel",
    },
    {
        era: 46,
        when: Date.now() / 1000,
        user: TEST_USER,
        message: "Unsafe content test <script>alert('oops')</script>",
        channel: "#test-channel",
    },
    {
        era: 47,
        when: Date.now() / 1000,
        user: TEST_USER,
        message: `Something something

on several lines!`,
        channel: "#test-channel",
    },
    {
        era: 48,
        when: Date.now() / 1000,
        user: TEST_USER,
        message: "Now with...\n\n...backslash n!",
        channel: "#test-channel",
    },
];

// Maps repository name to repository owner.
const KNOWN_REPOS_OWNERS = {
    "binjs-ref": "binast",
    cranelift: "cranestation",
    histoire: "batzillalliztab",
    "rust-frontend": "mozilla-spidermonkey",
    jsparagus: "mozilla-spidermonkey",
};

var USER_TO_DISPLAY_NAME = {};

function getDisplayName(user) {
    return USER_TO_DISPLAY_NAME[user] || user;
}

var DOM = {
    create(tag, attrs = {}) {
        const node = document.createElement(tag);
        for (const [name, value] of Object.entries(attrs)) {
            node.setAttribute(name, value);
        }
        return node;
    },
    createText(...args) {
        return document.createTextNode(...args);
    },
    byId(id) {
        return document.getElementById(id);
    },
    clearChildren(node) {
        var n;
        while ((n = node.lastChild)) {
            node.removeChild(n);
        }
    },
    anchorToRoute(route) {
        let link = DOM.create("a", { href: route });
        link.onclick = async (event) => {
            event.preventDefault();
            await goToRoute(route);
        };
        return link;
    },
};

var $HEADER_TITLE = DOM.byId("header-title");
var $HEADER_DATE = DOM.byId("header-date");
var $LIST = DOM.byId("thelist");

DOM.byId("backtoindex").onclick = async () => {
    await goToRoute("#");
};

var urls = {
    matrixTo(channel) {
        return `https://matrix.to/#/${channel}`;
    },
    edit(user, era) {
        user = encodeURIComponent(user);
        return `https://github.com/${BASE_REPO}/edit/master/users/${user}/${user}.${era}.txt`;
    },
    data(user, era) {
        user = encodeURIComponent(user);
        return `https://raw.githubusercontent.com/${BASE_REPO}/master/users/${user}/${user}.${era}.txt`;
    },
    bug(bugNumber) {
        return `https://bugzilla.mozilla.org/show_bug.cgi?id=${bugNumber}`;
    },
    list_users() {
        return `https://api.github.com/repos/${BASE_REPO}/contents/users`;
    },
    github_pr(repository, prNumber) {
        let owner = KNOWN_REPOS_OWNERS[repository.toLowerCase()];
        return typeof owner === "undefined"
            ? null
            : `https://github.com/${owner}/${repository}/pull/${prNumber}`;
    },
};

var router = {
    user_page(username, start, end) {
        if (start || end) {
            return `#user=${username}&start=${start}&end=${end}`;
        }
        return `#user=${username}`;
    },
    room_page(channel, start, end) {
        if (start || end) {
            return `#room=${encodeURIComponent(
                channel
            )}&start=${start}&end=${end}`;
        }
        return `#room=${encodeURIComponent(channel)}`;
    },
};

function toDateString(when) {
    const date = new Date(when * 1000);
    try {
        return new Intl.DateTimeFormat(navigator.languages, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        }).format(date);
    } catch (e) {
        return date.toLocaleString();
    }
}

function toDateInputString(when) {
    const date = new Date(when * 1000);
    return `${date.getFullYear()}-${(date.getMonth() + 1 + "").padStart(
        2,
        "0"
    )}-${(date.getDate() + "").padStart(2, "0")}`;
}

function fromDateInputString(value) {
    var m = value.match(/^([0-9]+)-([0-9]+)-([0-9]+)$/);
    if (!m) {
        return null;
    }

    var date = new Date(2000, 1, 1);
    date.setYear(parseInt(m[1], 10));
    date.setMonth(parseInt(m[2], 10) - 1);
    date.setDate(parseInt(m[3], 10));
    return Math.floor(date.getTime() / 1000);
}

const MARKDOWN_SEARCHES = [
    {
        name: "bug",
        regexp: /bug (\d+)/gi,
        createLink: (captures) => urls.bug(captures[0]),
        numCaptures: 1,
    },
    {
        name: "gh-shorthand",
        regexp: /([-a-zA-Z0-9_]+)#(\d+)/gi,
        createLink: (captures) => urls.github_pr(captures[0], captures[1]),
        numCaptures: 2,
    },
];

const markdownPlugin = (search) => (md) => {
    md.core.ruler.push(search.name, (state) => {
        let arrayReplaceAt = md.utils.arrayReplaceAt;

        function splitTextToken(text, level) {
            let token;
            let lastPos = 0;
            let newNodes = [];

            text.replace(search.regexp, function (match, ...rest) {
                let captures = [];
                for (let k = 0; k < search.numCaptures; k++) {
                    captures.push(rest.shift());
                }

                let offset = rest.shift();

                // Add new tokens to pending list.
                if (offset > lastPos) {
                    token = new state.Token("text", "", 0);
                    token.content = text.slice(lastPos, offset);
                    newNodes.push(token);
                }

                let fullUrl = search.createLink(captures);

                if (fullUrl !== null) {
                    token = new state.Token("link_open", "a", 1);
                    token.attrs = [["href", fullUrl]];
                    token.level = level++;
                    token.markup = search.name;
                    token.info = "auto";
                    newNodes.push(token);

                    token = new state.Token("text", "", 0);
                    token.content = match;
                    token.level = level;
                    newNodes.push(token);

                    token = new state.Token("link_close", "a", -1);
                    token.level = --level;
                    token.markup = search.name;
                    token.info = "auto";
                    newNodes.push(token);
                } else {
                    token = new state.Token("text", "", 0);
                    token.content = match;
                    token.level = level;
                    newNodes.push(token);
                }

                lastPos = offset + match.length;
            });

            if (lastPos < text.length) {
                // Add the remainder of the text.
                token = new state.Token("text", "", 0);
                token.content = text.slice(lastPos);
                newNodes.push(token);
            }

            return newNodes;
        }

        let blockTokens = state.tokens;
        let autolinkLevel = 0;

        for (let j = 0; j < blockTokens.length; j++) {
            if (blockTokens[j].type !== "inline") {
                continue;
            }

            let tokens = blockTokens[j].children;

            // We scan from the end, to keep position when new tags added.
            // Use reversed logic in links start/end match
            for (let i = tokens.length - 1; i >= 0; i--) {
                let token = tokens[i];

                if (token.type === "link_open" || token.type === "link_close") {
                    if (token.info === "auto") {
                        autolinkLevel -= token.nesting;
                    }
                }

                if (token.type === "text" && autolinkLevel === 0) {
                    if (search.regexp.test(token.content)) {
                        // replace current node
                        blockTokens[j].children = tokens = arrayReplaceAt(
                            tokens,
                            i,
                            splitTextToken(
                                token.content,
                                token.level,
                                state.Token
                            )
                        );
                    }
                }
            }
        }
    });
};

let Markdown = window.markdownit({ breaks: true, linkify: true });
for (let search of MARKDOWN_SEARCHES) {
    Markdown = Markdown.use(markdownPlugin(search));
}

function renderSingleUpdate(
    { era, when, user, message, channel },
    start,
    end,
    showUserLink
) {
    const item = DOM.create("li");

    const header = DOM.create("div", { class: "update-header" });

    const name = DOM.create("strong", { class: "name" });
    const nameText = DOM.createText(getDisplayName(user));
    if (showUserLink) {
        let link = DOM.anchorToRoute(router.user_page(user, start, end));
        link.appendChild(nameText);
        name.appendChild(link);
    } else {
        name.appendChild(nameText);
    }
    header.appendChild(name);

    header.appendChild(DOM.createText(" "));

    const time = DOM.create("small", { class: "time" });
    let timeSpan = DOM.create("span");

    if (channel.startsWith("#")) {
        const link = DOM.anchorToRoute(router.room_page(channel, start, end));
        let channelText = DOM.createText(channel);
        link.appendChild(channelText);
        time.appendChild(link);
    }

    let timeText = DOM.createText(toDateString(when));
    timeSpan.appendChild(timeText);
    time.appendChild(timeSpan);
    header.appendChild(time);

    header.appendChild(DOM.createText(" "));

    const edit = DOM.create("a", {
        class: "edit",
        href: urls.edit(user, era),
        target: "_blank",
        "aria-label": "edit",
    });
    // https://fontawesome.com/icons/edit?style=regular
    edit.appendChild(
        DOM.create("i", {
            class: "far fa-edit",
            title: "edit",
            "aria-hidden": "true",
        })
    );
    header.appendChild(edit);
    item.appendChild(header);

    const body = DOM.create("div", { class: "message" });
    body.innerHTML = Markdown.renderInline(message.replace(/\\n/g, '\n'));
    item.appendChild(body);

    $LIST.appendChild(item);
}

function parseResults(responseText, user, era, start, end) {
    const results = [];
    for (let line of responseText.split("\n")) {
        if (line === "") {
            continue;
        }
        const [_, when, channel, message] = line.match(/^(\S+) (\S+) (.*)/);
        if (when < start || when > end) {
            continue;
        }
        results.push({ user, era, when, channel, message });
    }
    return results;
}

function renderAllUsersLink() {
    let li = DOM.create("li");
    let link = DOM.anchorToRoute(router.user_page(ALL_USERS));
    link.textContent = "All users";
    li.appendChild(link);
    $LIST.appendChild(li);
}

function renderUser(name) {
    let li = DOM.create("li");
    let link = DOM.anchorToRoute(router.user_page(name));
    link.textContent = getDisplayName(name);
    li.appendChild(link);
    $LIST.appendChild(li);
}

function renderResults(
    fullUsers,
    channel,
    userName,
    showUserLink,
    start,
    end,
    results
) {
    DOM.clearChildren($LIST);

    if (results.length) {
        // Sort results by reverse date before rendering them.
        results.sort((a, b) => {
            return a.when < b.when ? 1 : a.when >= b.when ? -1 : 0;
        });
        $LIST.classList.add("update");
        for (const result of results) {
            renderSingleUpdate(result, start, end, showUserLink);
        }
    } else {
        let li = DOM.create("li");
        let text = DOM.createText("No updates found!");
        li.appendChild(text);
        $LIST.appendChild(li);
    }

    if (userName.length > 0 && userName[0] === "#") {
        // It has to be a channel!
        DOM.clearChildren($HEADER_TITLE);

        $HEADER_TITLE.appendChild(DOM.createText("Updates for "));

        let link = DOM.create("a", { href: urls.matrixTo(userName) });
        let linkText = DOM.createText(userName);
        link.appendChild(linkText);
        $HEADER_TITLE.appendChild(link);
    } else {
        $HEADER_TITLE.textContent = `Updates for ${userName}`;
    }

    var start_input = document.createElement("input");
    start_input.type = "date";
    start_input.min = toDateInputString(OLDEST_ERA);
    start_input.value = toDateInputString(start);

    var end_input = document.createElement("input");
    end_input.type = "date";
    end_input.min = toDateInputString(OLDEST_ERA);
    end_input.value = toDateInputString(end);

    var change_button = document.createElement("button");
    change_button.textContent = "Change";
    change_button.addEventListener("click", async () => {
        var new_start = fromDateInputString(start_input.value);
        var new_end = fromDateInputString(end_input.value);
        await goToRoute(
            channel !== null
                ? router.room_page(channel, new_start, new_end)
                : router.user_page(fullUsers, new_start, new_end)
        );
    });

    $HEADER_DATE.appendChild(document.createTextNode("from "));
    $HEADER_DATE.appendChild(start_input);
    $HEADER_DATE.appendChild(document.createTextNode(" to "));
    $HEADER_DATE.appendChild(end_input);
    $HEADER_DATE.appendChild(document.createTextNode(" "));
    $HEADER_DATE.appendChild(change_button);
}

async function runTest() {
    const start = 42;
    const end = 1337;
    await loadUserNotes(TEST_USER, start, end);
}

function loadUsers() {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("load", (ev) => resolve(xhr));
        xhr.open("GET", urls.list_users());

        let lastEtag = localStorage.getItem(LOCALSTORAGE_USERS_LAST_ETAG_KEY);
        if (lastEtag !== null) {
            xhr.setRequestHeader("If-None-Match", lastEtag);
        }

        xhr.send();
    });
}

// An in-memory cache for the fetchUsers request.
let LAST_FETCH_USERS = {
    timestamp: null,
    users: null,
};

// Fetch the user list from Github or from the local storage cache. Each
// username is fully extended, including the Matrix domain in particular.
//
// This is internally facing; prefer using the getUserList() function below.
async function fetchUsers() {
    if (
        !!LAST_FETCH_USERS.users &&
        Date.now() - LAST_FETCH_USERS.timestamp < 60 * 1000
    ) {
        return LAST_FETCH_USERS.users;
    }

    $HEADER_TITLE.textContent = "Loading users...";

    const xhr = await loadUsers();

    let status = (xhr.status / 100) | 0;
    // If the status code isn't in the 200 or 300 family, it's an error.
    if (status !== 2 && status !== 3) {
        let message;
        try {
            let json = JSON.parse(xhr.responseText);
            if (typeof json.message !== "undefined") {
                message = json.message;
            } else {
                throw new Error();
            }
        } catch (_) {
            message = xhr.responseText;
        }
        $HEADER_TITLE.textContent = `Error when fetching the list of users: ${message}`;
        return null;
    }

    let users;
    if (xhr.status === 304) {
        // Content not modified; reload from the cache.
        users = JSON.parse(localStorage.getItem(LOCALSTORAGE_USERS_KEY));
    } else {
        let json;
        try {
            json = JSON.parse(xhr.responseText);
        } catch (ex) {
            alert("Error when parsing the list of users: " + ex.toString());
            return null;
        }
        users = json
            .map((x) => x.name)
            .filter((name) => name !== ".gitattributes");

        let etag = xhr.getResponseHeader("ETag");
        if (etag !== null) {
            localStorage.setItem(LOCALSTORAGE_USERS_LAST_ETAG_KEY, etag);
            localStorage.setItem(LOCALSTORAGE_USERS_KEY, JSON.stringify(users));
        }
    }

    LAST_FETCH_USERS = { timestamp: Date.now(), users };

    return users;
}

// Retrieves the user list and computes the global USER_TO_DISPLAY_NAME
// mapping. Each username is fully extended, including the Matrix domain in
// particular.
async function getUserList() {
    let users;
    try {
        users = await fetchUsers();
    } catch (err) {
        console.log(
            "error when fetching users, using local storage or test user"
        );
        users = JSON.parse(
            localStorage.getItem(LOCALSTORAGE_USERS_KEY) || [TEST_USER]
        );
    }

    users.sort((a, b) => a.toLowerCase() > b.toLowerCase());

    USER_TO_DISPLAY_NAME = {};

    let prefixCount = new Map();
    for (let user of users) {
        let split = user.split(":");
        split.pop();
        let userPrefix = split.join(":");

        let prevCount = prefixCount.get(userPrefix) || [];
        prevCount.push(user);
        prefixCount.set(userPrefix, prevCount);

        USER_TO_DISPLAY_NAME[user] = user;
    }

    for (let [prefix, users] of prefixCount) {
        if (users.length === 1) {
            USER_TO_DISPLAY_NAME[users[0]] = prefix;
        }
    }

    return users;
}

async function listUsers() {
    const users = await getUserList();
    if (!users) {
        return;
    }
    renderAllUsersLink();
    users.map(renderUser);
    $HEADER_TITLE.textContent = "Users";
}

// In-memory cache for the result of the fetchUpdates function.
const LAST_FETCH_UPDATES = {};

function fetchUpdates(fullUser, era) {
    // index.html and index.js are loaded through rawgit.com, which routes them
    // through a CDN that caches aggressively. That doesn't work for the data
    // files, which are expected to be updated frequently. So we go through
    // github directly for those -- but note, not the /raw/ URL, since that
    // does not allow CORS, but the raw.githubusercontent.com link.
    const cacheKey = fullUser + "-" + era;
    return new Promise((resolve) => {
        const cacheEntry = LAST_FETCH_UPDATES[cacheKey];
        if (typeof cacheEntry !== "undefined") {
            // Only return the cache entry if it predates the current era, in
            // which case it's unlikely to have been modified in the meanwhile;
            // or when we've requested user updates for this user/era less than
            // a minute ago.
            let requestedRecently =
                Date.now() - cacheEntry.timestamp < 60 * 1000;
            if (era < CURRENT_ERA_START || requestedRecently) {
                resolve(cacheEntry.value);
                return;
            }
        }

        const xhr = new XMLHttpRequest();
        xhr.responseType = "text";
        xhr.addEventListener("load", () => {
            // 404 is ok; there might not be any entries for that time range.
            let result;
            if (xhr.status == 404) {
                result = "";
            } else {
                result = xhr.responseText;
            }
            LAST_FETCH_UPDATES[cacheKey] = {
                timestamp: Date.now(),
                value: result,
            };
            resolve(result);
        });
        xhr.open("GET", urls.data(fullUser, era));
        xhr.send();
    });
}

function computeEra(time_sec) {
    return time_sec - (time_sec % ERA_SECONDS);
}

async function fetchUpdatesForUsers(fullUsers, start, end) {
    $HEADER_TITLE.textContent = "Loading updates...";

    const promises = [];
    for (
        let era = computeEra(end);
        era >= computeEra(start);
        era -= ERA_SECONDS
    ) {
        for (const fullUser of fullUsers) {
            promises.push(
                (async () => {
                    const updatesText = await fetchUpdates(fullUser, era);
                    return parseResults(updatesText, fullUser, era, start, end);
                })()
            );
        }
    }

    // All attempted data is loaded.
    return [].concat(...(await Promise.all(promises)));
}

async function loadUserNotes(user, start, end, channel = null) {
    let users, results;
    if (user === TEST_USER || channel === TEST_CHANNEL) {
        // Testing mode.
        users = [TEST_USER];
        results = TEST_USER_UPDATES;
        start = 1;
        end = Date.now();
    } else if (user === ALL_USERS) {
        users = await getUserList();
        if (!users) {
            return;
        }
        results = await fetchUpdatesForUsers(users, start, end);
    } else {
        users = user.split(",").filter((x) => x);
        results = await fetchUpdatesForUsers(users, start, end);
    }

    if (channel !== null) {
        results = results.filter((resp) => resp.channel === channel);
    }

    const userName =
        channel !== null
            ? channel
            : user == ALL_USERS
            ? "all users"
            : users.map(getDisplayName).join(", ");

    const showUserLink = users.length > 1 || channel !== null;
    renderResults(users, channel, userName, showUserLink, start, end, results);
}

// Extracts parameters from the URL, at startup, and provide default values for
// those not filled. Returns an object with all the parsed values.
function parseHash() {
    var hash = location.hash;
    if (hash.length > 1 && hash[0] == "#") {
        hash = hash.substr(1);
    }
    if (hash.length > 1 && hash[0] == "/") {
        hash = hash.substr(1);
    }

    var params = new Map();
    for (let pair of hash.split("&")) {
        if (pair.indexOf("=") === -1) {
            continue;
        }
        let [key, value] = pair.split("=");
        params.set(key, value);
    }

    var user = params.get("user");
    var room = params.get("room");
    var test = params.get("test");

    var end = params.get("end");
    if (end) {
        end = parseInt(end, 10);
    } else {
        end = CURRENT_ERA_END;
    }

    var start = params.get("start");
    if (start) {
        start = parseInt(start, 10);
    } else {
        start = computeEra(end - LOOKBACK_SECONDS);
    }

    if (start < OLDEST_ERA) {
        start = OLDEST_ERA;
    }
    if (end < OLDEST_ERA) {
        end = OLDEST_ERA;
    }

    if (end < start) {
        end = start;
    }

    console.log(`Parsed route:
user=${user} room=${room} test=${test}
start=${start}
end=${end}
`);

    return {
        user,
        room,
        test,
        start,
        end,
    };
}

window.onpopstate = async () => {
    await renderRoute();
};

async function goToRoute(route) {
    history.pushState(null, null, route);
    await renderRoute();
}

async function renderRoute() {
    DOM.clearChildren($LIST);
    $LIST.classList = "";

    DOM.clearChildren($HEADER_TITLE);
    DOM.clearChildren($HEADER_DATE);

    let { user, room, test, start, end } = parseHash();

    if (test) {
        await runTest();
    } else if (room) {
        room = decodeURIComponent(room);
        await loadUserNotes(ALL_USERS, start, end, room);
    } else if (user) {
        await getUserList();
        await loadUserNotes(user, start, end);
    } else {
        await listUsers();
    }
}

renderRoute().catch((err) => {
    console.log("Promise error:", err);
    console.log("Stack:", err.stack);
});
