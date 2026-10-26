// auth, demo, ping
import { check, defineHandlers, Reply, requireBody, unauthorized } from "../http";
import { BAD_SESSION, emailAvailable, login, meResponse, register, userResponse, usernameAvailable } from "../services/users";

/** Аккаунты для кнопок на странице входа (как в DEMO_MODE бэкенда). */
const DEMO_ACCOUNTS = [
  { username: "admin", password: "demo-password-1", firstName: "Администратор", lastName: "Платформы", systemRole: "ADMIN" },
  { username: "anna", password: "demo-password-1", firstName: "Анна", lastName: "Смирнова", systemRole: "USER" },
  { username: "petr", password: "demo-password-1", firstName: "Пётр", lastName: "Волков", systemRole: "USER" },
  { username: "vika", password: "demo-password-1", firstName: "Виктория", lastName: "Крылова", systemRole: "USER" },
  { username: "ladya", password: "demo-password-1", firstName: "Игорь", lastName: "Савельев", systemRole: "ORG" },
  { username: "enisey", password: "demo-password-1", firstName: "Марина", lastName: "Соколова", systemRole: "ORG" },
];

defineHandlers({
  auth_register: (ctx) => {
    const body = requireBody(ctx);
    check(body, {
      username: { required: true, min: 3, max: 50 },
      email: { required: true, email: true, max: 255 },
      firstName: { required: true, min: 2, max: 100 },
      lastName: { required: true, min: 2, max: 100 },
      password: { required: true, min: 8, max: 128 },
    });
    return userResponse(register(body, ctx.now));
  },

  auth_login: (ctx) => {
    const body = requireBody(ctx);
    check(body, { username: { required: true }, password: { required: true } });
    const user = login(body.username, body.password);
    ctx.setSession(user.id as string);
    return userResponse(user);
  },

  auth_refresh: (ctx) => {
    if (!ctx.user) throw unauthorized(BAD_SESSION);
    return userResponse(ctx.user);
  },

  auth_logout: (ctx) => {
    ctx.setSession(null);
    return new Reply(204);
  },

  auth_me: (ctx) => {
    if (!ctx.user) throw unauthorized(BAD_SESSION);
    return meResponse(ctx.user, ctx.now);
  },

  auth_checkUsername: (ctx) => ({ available: usernameAvailable(ctx.query.str("username") ?? "") }),
  auth_checkEmail: (ctx) => ({ available: emailAvailable(ctx.query.str("email") ?? "") }),

  demo_accounts: () => DEMO_ACCOUNTS,
  ping: (ctx) => ({ status: "ok", time: new Date(ctx.now).toISOString() }),
});
