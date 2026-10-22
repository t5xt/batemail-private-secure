```css
/* Three-panel mail experience */
.mail-layout {
  display: grid;
  grid-template-columns: minmax(290px, 0.88fr) minmax(0, 1.35fr);
  min-height: 540px;
}

.message-list {
  min-width: 0;
  border-right: 1px solid var(--line);
}

.message-list-header {
  padding: 18px 18px 15px;
  border-bottom: 1px solid var(--line);
}

.message-list-heading h1 {
  margin: 0;
  font: 700 28px/1.15 var(--d);
  letter-spacing: -.6px;
}

.message-list-heading p {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.message-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 11px;
  width: 100%;
  padding: 16px 13px;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: var(--text);
  text-align: left;
  transition: background .2s;
}

.message-row:hover { background: #0d1b2d; }
.message-row.selected {
  background: linear-gradient(110deg, #142743, #0d192a);
  box-shadow: inset 2px 0 #2784ff;
}

.message-avatar, .sender-avatar {
  display: grid;
  place-items: center;
  width: 39px;
  height: 39px;
  flex: 0 0 39px;
  border-radius: 50%;
  background: #1a3558;
  color: #d8e8ff;
  font-weight: 600;
}

.message-row-content {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 4px;
}

.message-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.message-sender {
  overflow: hidden;
  color: #e2edff;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-time {
  flex: none;
  color: var(--muted);
  font-size: 11px;
}

.message-subject {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-preview {
  display: -webkit-box;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.unread-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 8px;
  margin-top: 26px;
  border-radius: 50%;
  background: var(--blue);
}

.reading-panel { min-width: 0; }

.message-reading {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 24px;
}

.reading-header {
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
}

.reading-header h2 {
  margin: 0 0 19px;
  font: 700 clamp(21px, 2vw, 27px)/1.2 var(--d);
  letter-spacing: -.4px;
  overflow-wrap: anywhere;
}

.reading-sender-line {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.sender-avatar {
  width: 46px;
  height: 46px;
  flex-basis: 46px;
}

.sender-details {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.sender-details strong {
  overflow-wrap: anywhere;
  font-size: 13px;
}

.sender-details span {
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 12px;
}

.reading-time {
  align-self: flex-start;
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

.email-body-card {
  margin-top: 20px;
  padding: clamp(18px, 3vw, 30px);
  border: 1px solid var(--line);
  border-radius: 13px;
  background: linear-gradient(150deg, #091522, #060d16);
}

.email-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 26px;
  font: 700 20px var(--d);
}

.email-brand-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: #dceaff;
  color: #10223c;
}

.email-body-text {
  color: #dce8fa;
  font-size: 14px;
  line-height: 1.85;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.email-details {
  display: grid;
  gap: 5px;
  margin-top: 20px;
  padding-top: 17px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.reading-actions {
  display: flex;
  justify-content: flex-start;
  margin-top: 20px;
}

.reading-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  padding: 30px;
  text-align: center;
}

.reading-empty-icon {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border: 1px solid #294a75;
  border-radius: 18px;
  background: #10213a;
  color: #a9cbff;
  font-size: 27px;
}

.reading-empty h2 {
  margin: 17px 0 5px;
  font: 700 21px var(--d);
}

.reading-empty p {
  max-width: 280px;
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.refresh-error {
  margin: 0 0 10px;
  padding: 10px 13px;
  border: 1px solid #78404b;
  border-radius: 9px;
  background: #28131a;
  color: #ffc2cb;
  font-size: 13px;
}

@media (max-width: 1000px) {
  .mail-layout {
    grid-template-columns: minmax(245px, .8fr) minmax(0, 1.2fr);
  }

  .message-reading { padding: 17px; }
  .message-row { padding: 14px 10px; }
}

@media (max-width: 700px) {
  .mail-layout { grid-template-columns: minmax(0, 1fr); }

  .message-list {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .message-list-header { padding: 15px; }

  .message-list-heading h1 { font-size: 24px; }

  .message-row { padding: 13px; }

  .message-reading { padding: 19px 14px; }

  .email-body-card { padding: 19px; }

  .reading-header h2 { font-size: 23px; }
}
```
