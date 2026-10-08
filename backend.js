const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

function loadLocalEnvironment() {
  let contents;
  try {
    contents = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(?:"(.*)"|'(.*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
  }
}

loadLocalEnvironment();

const port = Number(process.env.PORT) || 3000;
const root = __dirname;
const environmentFile = path.join(root, ".env");
const dataDirectory = path.join(root, "data");
const productFile = path.join(dataDirectory, "products.json");
const customerFile = path.join(dataDirectory, "customers.json");
const orderFile = path.join(dataDirectory, "orders.jsonl");
const reviewFile = path.join(dataDirectory, "reviews.json");
const uploadDirectory = path.join(root, "assets", "uploads");
const sessionCookie = "jasper_session";
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const allowedStatuses = ["Awaiting transfer", "Payment confirmed", "Processing", "Dispatched", "Delivered", "Cancelled"];

const categories = [
  { id: "panels", name: "Solar Panels", image: "/assets/jasper_solarworld_sler_10.png" },
  { id: "inverters", name: "Inverters", image: "/assets/jasper_solarworld_slider_06.png" },
  { id: "batteries", name: "Batteries", image: "/assets/inverter.png" },
  { id: "accessories", name: "Solar Accessories", image: "/assets/jasper_solarworld_sler_04.png" },
  { id: "gadgets", name: "Electrical Gadgets", image: "/assets/jasper_solarworld_sl11.png" },
  { id: "lighting", name: "Lighting Solutions", image: "/assets/jasper_solarworld_sli.png" }
];

const seedProducts = [
  { id: "panel-550w", name: "550W Monocrystalline Solar Panel", category: "panels", categoryName: "Solar Panels", price: 180000, description: "A 550W monocrystalline panel for a correctly sized solar installation. Confirm voltage, mounting, and inverter compatibility with a qualified installer before ordering.", image: "/assets/jasper_solarworld_sler_10.png", active: true },
  { id: "inverter-35kva", name: "3.5KVA Hybrid Inverter (48V)", category: "inverters", categoryName: "Inverters", price: 250000, description: "A 48V hybrid inverter for compatible solar and battery systems. Ask us to check your planned load and battery configuration before purchase.", image: "/assets/jasper_solarworld_slider_06.png", active: true },
  { id: "battery-200ah", name: "200AH Gel Battery (12V)", category: "batteries", categoryName: "Batteries", price: 320000, description: "A 12V, 200Ah gel battery. Battery runtime depends on usable capacity, system voltage, and the appliances connected to it.", image: "/assets/inverter.png", active: true },
  { id: "floodlight-100w", name: "100W Solar LED Flood Light", category: "lighting", categoryName: "Lighting Solutions", price: 45000, description: "A 100W solar LED flood light for outdoor areas. Check included battery, panel, mounting, and weather-rating details with our team before ordering.", image: "/assets/jasper_solarworld_sler07.png", active: true },
  { id: "solar-cable-100m", name: "Solar Cable (4mm) — 100m", category: "accessories", categoryName: "Solar Accessories", price: 38000, description: "A 100-metre roll of 4mm solar cable. A qualified installer should confirm conductor size and cable run for your system.", image: "/assets/jasper_solarworld_sler_04.png", active: true },
  { id: "mppt-60a", name: "MPPT Charge Controller (60A)", category: "inverters", categoryName: "Inverters", price: 85000, description: "A 60A MPPT solar charge controller. Confirm panel voltage, battery chemistry, and current limits against the manufacturer specifications.", image: "/assets/jasper_solarworld_sler07.png", active: true },
  { id: "bulb-12w", name: "12W LED Bulb (Solar)", category: "lighting", categoryName: "Lighting Solutions", price: 5500, description: "A 12W LED bulb intended for compatible solar lighting setups. Confirm its operating voltage and fitting before purchase.", image: "/assets/jasper_solarworld_sli.png", active: true },
  { id: "electrical-set", name: "MCB & Electrical Accessories Set", category: "gadgets", categoryName: "Electrical Gadgets", price: 22000, description: "A selection of electrical accessories for compatible installations. Electrical protection equipment must be selected and installed by a qualified electrician.", image: "/assets/jasper_solarworld_sl11.png", active: true }
];

const mimeTypes = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const publicPages = new Set(["index.html", "admin.html", "about.html", "guides.html", "privacy.html", "shipping.html", "robots.txt", "sitemap.xml", "ads.txt"]);

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(temporaryPath, filePath);
}

async function updateLocalEnvironment(updates) {
  let lines = [];
  try {
    lines = (await fsp.readFile(environmentFile, "utf8")).split(/\r?\n/);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const [key, value] of Object.entries(updates)) {
    const prefix = new RegExp(`^\\s*${key}\\s*=`);
    const index = lines.findIndex(line => prefix.test(line));
    const entry = `${key}=${JSON.stringify(value)}`;
    if (index < 0) lines.push(entry);
    else lines[index] = entry;
  }
  await fsp.writeFile(environmentFile, `${lines.filter((line, index, source) => line || index < source.length - 1).join("\n").trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
}

async function getProducts() {
  return readJsonFile(productFile, seedProducts);
}

async function getCustomers() {
  return readJsonFile(customerFile, []);
}

async function readJson(request, maxBytes = 32_768) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(payload));
}

function equalText(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function requestIp(request) {
  return request.socket.remoteAddress || "unknown";
}

function blockedByRateLimit(request) {
  const attempt = loginAttempts.get(requestIp(request));
  if (!attempt) return false;
  if (Date.now() - attempt.startedAt > 15 * 60 * 1000) {
    loginAttempts.delete(requestIp(request));
    return false;
  }
  return attempt.count >= 10;
}

function noteFailedLogin(request) {
  const ip = requestIp(request);
  const attempt = loginAttempts.get(ip);
  if (!attempt || Date.now() - attempt.startedAt > 15 * 60 * 1000) loginAttempts.set(ip, { startedAt: Date.now(), count: 1 });
  else attempt.count += 1;
}

function clearFailedLogins(request) {
  loginAttempts.delete(requestIp(request));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map(cookie => cookie.trim().split(/=(.*)/s).slice(0, 2)).filter(([key, value]) => key && value));
}

function setSessionCookie(request, response, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeMs / 1000}${secure}`);
}

function clearSessionCookie(request, response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function currentSession(request) {
  const token = parseCookies(request)[sessionCookie];
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { ...session, token };
}

function requireRole(request, response, role) {
  const session = currentSession(request);
  if (!session || session.role !== role) {
    sendJson(response, 401, { error: "Please sign in to continue." });
    return null;
  }
  return session;
}

function createSession(request, response, role, userId, name) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { role, userId, name, expiresAt: Date.now() + sessionLifetimeMs });
  setSessionCookie(request, response, token);
  return token;
}

function publicCustomer(customer) {
  return { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone, createdAt: customer.createdAt };
}

function paymentDetails() {
  const details = { bankName: process.env.BANK_NAME || "", accountName: process.env.BANK_ACCOUNT_NAME || "", accountNumber: process.env.BANK_ACCOUNT_NUMBER || "" };
  return { configured: Boolean(details.bankName && details.accountName && /^\d{10}$/.test(details.accountNumber)), ...details };
}

async function readOrders() {
  let contents;
  try {
    contents = await fsp.readFile(path.join(dataDirectory, "orders.jsonl"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const latest = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const order = JSON.parse(line);
      latest.set(order.orderId, order);
    } catch {
      continue;
    }
  }
  return [...latest.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function appendOrder(order) {
  await fsp.mkdir(dataDirectory, { recursive: true });
  await fsp.appendFile(path.join(dataDirectory, "orders.jsonl"), `${JSON.stringify(order)}\n`, "utf8");
}

function reviewSummary(reviews) {
  const count = reviews.length;
  const average = count ? reviews.reduce((total, review) => total + review.rating, 0) / count : 0;
  return { reviewCount: count, averageRating: count ? Math.round(average * 10) / 10 : null };
}

function publicReview(review) {
  return { rating: review.rating, comment: review.comment, author: review.author, createdAt: review.createdAt, verifiedPurchase: true };
}

async function handleReview(request, response, session) {
  const body = await readJson(request);
  const productId = String(body.productId || "");
  const orderId = String(body.orderId || "");
  const rating = Number(body.rating);
  const comment = String(body.comment || "").trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return sendJson(response, 400, { error: "Choose a rating from 1 to 5 stars." });
  if (comment.length < 10 || comment.length > 1000) return sendJson(response, 400, { error: "Write a review between 10 and 1,000 characters." });
  const orders = await readOrders();
  const order = orders.find(entry => entry.orderId === orderId && entry.customerId === session.userId);
  if (!order || order.status !== "Delivered" || !order.items.some(item => item.id === productId)) return sendJson(response, 403, { error: "A review is available after this product has been marked delivered on your order." });
  const reviews = await readJsonFile(reviewFile, []);
  if (reviews.some(review => review.orderId === orderId && review.productId === productId && review.customerId === session.userId)) return sendJson(response, 409, { error: "You have already reviewed this delivered product." });
  const customer = (await getCustomers()).find(entry => entry.id === session.userId);
  if (!customer) return sendJson(response, 401, { error: "Please sign in again." });
  const review = { id: crypto.randomUUID(), productId, orderId, customerId: customer.id, author: customer.name.trim().split(/\s+/)[0], rating, comment, createdAt: new Date().toISOString() };
  reviews.push(review);
  await writeJsonFile(reviewFile, reviews);
  sendJson(response, 201, { review: publicReview(review) });
}

function validPhone(phone) {
  return /^\+?[0-9][0-9 ()-]{6,22}$/.test(phone);
}

async function handleSignup(request, response) {
  if (blockedByRateLimit(request)) return sendJson(response, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
  const body = await readJson(request);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const phone = String(body.phone || "").trim();
  const password = String(body.password || "");
  if (name.length < 2 || name.length > 100) return sendJson(response, 400, { error: "Enter your full name." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return sendJson(response, 400, { error: "Enter a valid email address." });
  if (!validPhone(phone)) return sendJson(response, 400, { error: "Enter a valid phone number." });
  if (password.length < 8 || password.length > 200) return sendJson(response, 400, { error: "Use a password with at least 8 characters." });
  const customers = await getCustomers();
  if (customers.some(customer => customer.email === email)) return sendJson(response, 409, { error: "An account with that email already exists." });
  const salt = crypto.randomBytes(16).toString("hex");
  const customer = { id: crypto.randomUUID(), name, email, phone, salt, passwordHash: crypto.scryptSync(password, salt, 64).toString("hex"), createdAt: new Date().toISOString() };
  customers.push(customer);
  await writeJsonFile(customerFile, customers);
  clearFailedLogins(request);
  createSession(request, response, "customer", customer.id, customer.name);
  sendJson(response, 201, { customer: publicCustomer(customer) });
}

async function handleCustomerLogin(request, response) {
  if (blockedByRateLimit(request)) return sendJson(response, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const customers = await getCustomers();
  const customer = customers.find(entry => entry.email === email);
  const hash = customer ? crypto.scryptSync(password, customer.salt, 64).toString("hex") : crypto.scryptSync(password, "jasper-solar-world", 64).toString("hex");
  if (!customer || !equalText(hash, customer.passwordHash)) {
    noteFailedLogin(request);
    return sendJson(response, 401, { error: "Email or password is incorrect." });
  }
  clearFailedLogins(request);
  createSession(request, response, "customer", customer.id, customer.name);
  sendJson(response, 200, { customer: publicCustomer(customer) });
}

async function handleAdminLogin(request, response) {
  if (blockedByRateLimit(request)) return sendJson(response, 429, { error: "Too many sign-in attempts. Try again in 15 minutes." });
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) return sendJson(response, 503, { error: "Admin access is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env." });
  const body = await readJson(request);
  if (!equalText(body.username || "", process.env.ADMIN_USERNAME) || !equalText(body.password || "", process.env.ADMIN_PASSWORD)) {
    noteFailedLogin(request);
    return sendJson(response, 401, { error: "Username or password is incorrect." });
  }
  clearFailedLogins(request);
  createSession(request, response, "admin", "admin", "Administrator");
  sendJson(response, 200, { authenticated: true, username: process.env.ADMIN_USERNAME });
}

async function handleAdminCredentialChange(request, response) {
  const body = await readJson(request);
  const currentPassword = String(body.currentPassword || "");
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!equalText(currentPassword, process.env.ADMIN_PASSWORD || "")) return sendJson(response, 401, { error: "Current password is incorrect." });
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) return sendJson(response, 400, { error: "Username must be 3 to 40 letters, numbers, dots, hyphens, or underscores." });
  if (password.length < 12 || password.length > 200) return sendJson(response, 400, { error: "Use a new password with at least 12 characters." });
  await updateLocalEnvironment({ ADMIN_USERNAME: username, ADMIN_PASSWORD: password });
  process.env.ADMIN_USERNAME = username;
  process.env.ADMIN_PASSWORD = password;
  for (const [token, session] of sessions) {
    if (session.role === "admin") sessions.delete(token);
  }
  clearSessionCookie(request, response);
  sendJson(response, 200, { credentialsChanged: true });
}

function normalizeProduct(body, existing, products) {
  const name = String(body.name || "").trim();
  const category = categories.find(item => item.id === body.category);
  const description = String(body.description || "").trim();
  const price = Number(body.price);
  const image = String(body.image || "").trim();
  if (name.length < 3 || name.length > 120) return { error: "Product names must be 3 to 120 characters." };
  if (!category) return { error: "Choose a valid product category." };
  if (!Number.isSafeInteger(price) || price < 1 || price > 1_000_000_000) return { error: "Enter a valid price in naira." };
  if (description.length < 30 || description.length > 1200) return { error: "Add a useful product description (30 to 1,200 characters)." };
  if (!/^https:\/\//i.test(image) && !/^\/assets\/[a-z0-9_.-]+\.(?:png|jpe?g|webp)$/i.test(image) && !/^\/assets\/uploads\/[a-f0-9-]+\.(?:png|jpe?g|webp)$/i.test(image)) return { error: "Use an HTTPS image URL or upload a product image." };
  if (products.some(product => product.id !== existing?.id && product.name.toLowerCase() === name.toLowerCase())) return { error: "A product with that name already exists." };
  return { product: { id: existing?.id || `prod-${crypto.randomBytes(8).toString("hex")}`, name, category: category.id, categoryName: category.name, price, description, image, active: body.active !== false } };
}

function imageMatchesType(buffer, type) {
  if (type === "image/png") return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === "image/jpeg") return buffer.length > 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (type === "image/webp") return buffer.length > 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}

async function handleUpload(request, response) {
  const body = await readJson(request, 7_100_000);
  const match = String(body.data || "").match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return sendJson(response, 400, { error: "Upload a PNG, JPEG, or WebP image." });
  const image = Buffer.from(match[2], "base64");
  if (image.length > 5 * 1024 * 1024 || !imageMatchesType(image, match[1])) return sendJson(response, 400, { error: "The image is invalid or exceeds the 5 MB limit." });
  const extension = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[match[1]];
  const filename = `${crypto.randomUUID()}${extension}`;
  await fsp.mkdir(uploadDirectory, { recursive: true });
  await fsp.writeFile(path.join(uploadDirectory, filename), image, { flag: "wx" });
  sendJson(response, 201, { image: `/assets/uploads/${filename}` });
}

async function handleOrder(request, response, session) {
  const bank = paymentDetails();
  if (!bank.configured) return sendJson(response, 503, { error: "Online bank-transfer checkout is unavailable until Jasper Solar World configures its account details." });
  const body = await readJson(request);
  const deliveryAddress = String(body.deliveryAddress || "").trim();
  if (deliveryAddress.length < 8 || deliveryAddress.length > 500) return sendJson(response, 400, { error: "Enter a complete delivery address." });
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) return sendJson(response, 400, { error: "Your order must include at least one product." });
  const customer = (await getCustomers()).find(entry => entry.id === session.userId);
  if (!customer) return sendJson(response, 401, { error: "Please sign in again before placing your order." });
  const products = await getProducts();
  const quantities = new Map();
  for (const item of body.items) {
    const quantity = Number(item.quantity);
    if (!products.some(product => product.id === item.id && product.active) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return sendJson(response, 400, { error: "One or more order items are invalid." });
    quantities.set(item.id, (quantities.get(item.id) || 0) + quantity);
  }
  if ([...quantities.values()].some(quantity => quantity > 20)) return sendJson(response, 400, { error: "The maximum quantity per product is 20." });
  const items = [...quantities.entries()].map(([id, quantity]) => {
    const product = products.find(entry => entry.id === id);
    return { id, name: product.name, unitPrice: product.price, quantity, total: product.price * quantity };
  });
  const order = {
    orderId: `JSW-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    trackingNumber: `JSWT-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    status: "Awaiting transfer",
    createdAt: new Date().toISOString(),
    customerId: session.userId,
    customer: { ...publicCustomer(customer), address: deliveryAddress },
    items,
    total: items.reduce((sum, item) => sum + item.total, 0)
  };
  await appendOrder(order);
  sendJson(response, 201, { orderId: order.orderId, trackingNumber: order.trackingNumber, status: order.status, total: order.total, payment: bank });
}

async function serveStatic(request, response, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return sendJson(response, 400, { error: "Invalid path." }); }
  const route = decoded === "/" ? "/index.html" : decoded === "/admin" ? "/admin.html" : decoded;
  const allowedAsset = /^\/assets\/(?:[a-z0-9_. -]+\.(?:png|jpe?g|webp)|uploads\/[a-f0-9-]+\.(?:png|jpe?g|webp))$/i.test(route);
  const isPublicPage = publicPages.has(route.slice(1));
  if (!allowedAsset && !isPublicPage) return sendJson(response, 404, { error: "Not found." });
  const filePath = path.resolve(root, `.${route}`);
  if (!filePath.startsWith(`${root}${path.sep}`)) return sendJson(response, 403, { error: "Forbidden." });
  try {
    const contents = await fsp.readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" });
    if (request.method === "HEAD") return response.end();
    response.end(contents);
  } catch (error) {
    sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: error.code === "ENOENT" ? "Not found." : "Unable to read file." });
  }
}

const server = http.createServer(async (request, response) => {
  let url;
  try { url = new URL(request.url, `http://${request.headers.host || "localhost"}`); }
  catch { return sendJson(response, 400, { error: "Invalid request URL." }); }
  const method = request.method;
  try {
    if (method === "GET" && url.pathname === "/api/products") {
      const products = (await getProducts()).filter(product => product.active);
      const reviews = await readJsonFile(reviewFile, []);
      return sendJson(response, 200, { categories, products: products.map(product => ({ ...product, ...reviewSummary(reviews.filter(review => review.productId === product.id)) })) });
    }
    const productDetailMatch = url.pathname.match(/^\/api\/products\/([A-Za-z0-9-]+)$/);
    if (method === "GET" && productDetailMatch) {
      const product = (await getProducts()).find(entry => entry.id === productDetailMatch[1] && entry.active);
      if (!product) return sendJson(response, 404, { error: "Product not found." });
      const allReviews = await readJsonFile(reviewFile, []);
      const reviews = allReviews.filter(review => review.productId === product.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const session = currentSession(request);
      const deliveredOrder = session?.role === "customer" ? (await readOrders()).find(order => order.customerId === session.userId && order.status === "Delivered" && order.items.some(item => item.id === product.id) && !allReviews.some(review => review.customerId === session.userId && review.orderId === order.orderId && review.productId === product.id)) : null;
      return sendJson(response, 200, { product: { ...product, ...reviewSummary(reviews) }, reviews: reviews.map(publicReview), reviewEligibility: { canReview: Boolean(deliveredOrder), orderId: deliveredOrder?.orderId || null } });
    }
    if (method === "POST" && url.pathname === "/api/reviews") {
      const session = requireRole(request, response, "customer");
      if (!session) return;
      return await handleReview(request, response, session);
    }
    if (method === "GET" && url.pathname === "/api/payment-info") return sendJson(response, 200, paymentDetails());
    if (method === "POST" && url.pathname === "/api/auth/signup") return await handleSignup(request, response);
    if (method === "POST" && url.pathname === "/api/auth/login") return await handleCustomerLogin(request, response);
    if (method === "POST" && url.pathname === "/api/admin/login") return await handleAdminLogin(request, response);
    if (method === "POST" && url.pathname === "/api/auth/logout") {
      const session = currentSession(request);
      if (session) sessions.delete(session.token);
      clearSessionCookie(request, response);
      return sendJson(response, 200, { signedOut: true });
    }
    if (method === "GET" && url.pathname === "/api/auth/me") {
      const session = currentSession(request);
      if (!session || session.role !== "customer") return sendJson(response, 200, { customer: null });
      const customer = (await getCustomers()).find(entry => entry.id === session.userId);
      return sendJson(response, 200, { customer: customer ? publicCustomer(customer) : null });
    }
    if (method === "GET" && url.pathname === "/api/auth/orders") {
      const session = requireRole(request, response, "customer");
      if (!session) return;
      return sendJson(response, 200, { orders: (await readOrders()).filter(order => order.customerId === session.userId).map(({ customerId, ...order }) => order) });
    }
    if (method === "POST" && url.pathname === "/api/orders") {
      const session = requireRole(request, response, "customer");
      if (!session) return;
      return await handleOrder(request, response, session);
    }
    const trackingMatch = url.pathname.match(/^\/api\/track\/(JSWT-[A-F0-9]{12})$/i);
    if (method === "GET" && trackingMatch) {
      const trackingNumber = trackingMatch[1].toUpperCase();
      const order = (await readOrders()).find(entry => entry.trackingNumber === trackingNumber);
      if (!order) return sendJson(response, 404, { error: "Tracking number not found." });
      return sendJson(response, 200, { trackingNumber, status: order.status, createdAt: order.createdAt, updatedAt: order.updatedAt || null, itemCount: order.items.reduce((total, item) => total + item.quantity, 0) });
    }
    const customerOrderMatch = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)$/);
    if (method === "GET" && customerOrderMatch) {
      const session = requireRole(request, response, "customer");
      if (!session) return;
      const order = (await readOrders()).find(entry => entry.orderId === customerOrderMatch[1] && entry.customerId === session.userId);
      if (!order) return sendJson(response, 404, { error: "Order not found." });
      return sendJson(response, 200, { orderId: order.orderId, status: order.status, createdAt: order.createdAt, total: order.total });
    }
    if (url.pathname.startsWith("/api/admin/")) {
      if (url.pathname === "/api/admin/me" && method === "GET") {
        const session = currentSession(request);
        if (!session || session.role !== "admin") return sendJson(response, 200, { authenticated: false });
        return sendJson(response, 200, { authenticated: true, username: process.env.ADMIN_USERNAME });
      }
      if (url.pathname === "/api/admin/logout" && method === "POST") {
        const session = currentSession(request);
        if (session) sessions.delete(session.token);
        clearSessionCookie(request, response);
        return sendJson(response, 200, { signedOut: true });
      }
      const admin = requireRole(request, response, "admin");
      if (!admin) return;
      if (method === "PATCH" && url.pathname === "/api/admin/credentials") return await handleAdminCredentialChange(request, response);
      if (method === "GET" && url.pathname === "/api/admin/products") return sendJson(response, 200, { products: await getProducts(), categories });
      if (method === "POST" && url.pathname === "/api/admin/uploads") return await handleUpload(request, response);
      if (method === "POST" && url.pathname === "/api/admin/products") {
        const body = await readJson(request);
        const current = await getProducts();
        const result = normalizeProduct(body, null, current);
        if (result.error) return sendJson(response, 400, { error: result.error });
        current.unshift(result.product);
        await writeJsonFile(productFile, current);
        return sendJson(response, 201, { product: result.product });
      }
      const productMatch = url.pathname.match(/^\/api\/admin\/products\/([A-Za-z0-9-]+)$/);
      if (productMatch && (method === "PUT" || method === "DELETE")) {
        const current = await getProducts();
        const index = current.findIndex(product => product.id === productMatch[1]);
        if (index < 0) return sendJson(response, 404, { error: "Product not found." });
        if (method === "DELETE") {
          current.splice(index, 1);
          await writeJsonFile(productFile, current);
          return sendJson(response, 200, { deleted: true });
        }
        const body = await readJson(request);
        const result = normalizeProduct(body, current[index], current);
        if (result.error) return sendJson(response, 400, { error: result.error });
        current[index] = result.product;
        await writeJsonFile(productFile, current);
        return sendJson(response, 200, { product: result.product });
      }
      if (method === "GET" && url.pathname === "/api/admin/orders") return sendJson(response, 200, { orders: await readOrders() });
      const statusMatch = url.pathname.match(/^\/api\/admin\/orders\/([A-Za-z0-9-]+)$/);
      if (statusMatch && method === "PATCH") {
        const body = await readJson(request);
        if (!allowedStatuses.includes(body.status)) return sendJson(response, 400, { error: "Choose a valid order status." });
        const order = (await readOrders()).find(entry => entry.orderId === statusMatch[1]);
        if (!order) return sendJson(response, 404, { error: "Order not found." });
        order.status = body.status;
        order.updatedAt = new Date().toISOString();
        await appendOrder(order);
        return sendJson(response, 200, { orderId: order.orderId, status: order.status });
      }
      if (method === "GET" && url.pathname === "/api/admin/customers") {
        const customers = (await getCustomers()).map(publicCustomer).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return sendJson(response, 200, { customers });
      }
      return sendJson(response, 404, { error: "Admin endpoint not found." });
    }
    if (method === "GET" || method === "HEAD") return await serveStatic(request, response, url.pathname);
    sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "The server could not complete the request." });
  }
});

server.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`Jasper Solar World is running at http://localhost:${port}`);
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) console.warn("Admin dashboard locked: configure ADMIN_USERNAME and ADMIN_PASSWORD in .env.");
  if (!paymentDetails().configured) console.warn("Bank-transfer checkout disabled: configure BANK_NAME, BANK_ACCOUNT_NAME, and BANK_ACCOUNT_NUMBER in .env.");
});