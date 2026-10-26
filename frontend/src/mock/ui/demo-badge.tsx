// Плашка «Демо-версия»: объясняет, что бэкенда нет, и даёт сбросить мир к исходному состоянию.
import { useState } from "react";
import { resetWorld } from "../db";

export default function DemoBadge() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed bottom-20 left-3 z-50 text-[13px] md:bottom-4">
      {open && (
        <div className="mb-2 w-72 rounded-2xl border-2 border-ink bg-paper p-4 shadow-hard">
          <p className="font-extrabold text-ink">Демо-версия «Движа»</p>
          <p className="mt-1 text-ink/80">
            Бэкенд отключён: все данные и ваши действия хранятся только в этом браузере. Другие участники отвечают на ваши заявки и вопросы
            автоматически.
          </p>
          <p className="mt-2 text-ink/60">Фото — свободные лицензии Wikimedia Commons и randomuser.me, подробности в CREDITS.</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              className="rounded-full border-2 border-ink bg-lemon px-3 py-1 font-extrabold text-ink disabled:opacity-60"
              onClick={() => {
                if (!window.confirm("Сбросить демо? Все ваши записи, встречи и сообщения будут удалены.")) return;
                setBusy(true);
                void resetWorld();
              }}
            >
              Сбросить данные
            </button>
            <a className="rounded-full border-2 border-ink px-3 py-1 font-extrabold text-ink" href="/media/CREDITS.md" target="_blank" rel="noreferrer">
              CREDITS
            </a>
          </div>
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        className="rounded-full border-2 border-ink bg-ultramarine px-3 py-1.5 font-extrabold text-white shadow-hard"
        onClick={() => setOpen((v) => !v)}
      >
        Демо-версия
      </button>
    </div>
  );
}
