# Thai Audio Text-Editor

แอปเดสก์ท็อปออฟไลน์สำหรับตัดต่อเสียงพูดภาษาไทยด้วยการแก้ transcript
(text-based audio editing — ดูรายละเอียดสถาปัตยกรรมและกติกาใน [CLAUDE.md](CLAUDE.md))

> 📖 **ผู้ใช้งานทั่วไป:** วิธีติดตั้งอ่านที่ [ติดตั้ง.md](ติดตั้ง.md) —
> วิธีใช้งาน + **ปุ่มลัดทั้งหมด** อ่านที่ [คู่มือการใช้.md](คู่มือการใช้.md)

สถานะปัจจุบัน: **Phase 9 — รองรับไฟล์ยาวเป็นชั่วโมง** 🎉 ไฟล์เกิน 20 นาที
เข้า "โหมดไฟล์ยาว" อัตโนมัติ: เสียงสตรีมจากดิสก์แทนการโหลดเข้า RAM
(ไฟล์ 30 นาทีเปิดด้วยหน่วยความจำ ~10MB จากเดิม ~2GB — โน้ตบุ๊ค RAM 8GB
ใช้ได้สบาย), spectrogram/ตัด/snap ดึงเสียงเฉพาะช่วงที่มอง, และ export
เป็นแบบสตรีมทุกกรณี (RAM คงที่ไม่ว่าไฟล์ยาวแค่ไหน) — บนความสามารถเดิมครบ:
ตัวติดตั้งดับเบิลคลิก .exe/.dmg, ถอดเสียง/ตรึงบท → แก้บท → ตัดเสียง →
Export (WAV + .docx/.txt) ทุกอย่างออฟไลน์ ต้นฉบับไม่ถูกแตะ
- หมายเหตุโหมดไฟล์ยาว: ครั้งแรกที่เปิดไฟล์แอปจะ "เตรียมไฟล์" สักครู่
  (สร้างสำเนา WAV ในแคช ~600MB/ชั่วโมง เก็บ 3 ไฟล์ล่าสุด) — waveform
  ตอนซูมวาดจากเสียงจริงของช่วงที่มอง (9e) จึงคมเท่าโหมดปกติ

ความสามารถสะสมจาก Phase 6:
**ตรึงบท (มีบทแล้ว)** เปิดเสียง+ไฟล์บท .txt/.docx ข้าม ASR ไปเลย (เหมาะกับ
ไฟล์เก่าที่มีบทถูกต้องอยู่แล้ว และเสียงแย่ที่ ASR เอาไม่อยู่ — บรรทัดที่ไม่ตรง
เสียงจะขีดแดงให้ตรวจ ไม่ล้มทั้งงาน), **แก้ทั้งวรรค** (✎ หน้าวรรค → พิมพ์อิสระ
→ Enter → ระบบตรึงเวลาใหม่เฉพาะวรรคนั้น การตัดที่มีอยู่ไม่หาย),
**Tab queue** (Tab = เด้งไปคำขีดแดงถัดไป + เล่นเสียงให้ฟัง + เปิดกล่องแก้)
+ ทุกอย่างจากเฟสก่อน: ตัดเสียง/spectrogram คม/sample zoom/test cut/undo
ถัดไป: **Export** (เสียง WAV + .docx เนื้อหาสะอาด)

## โครงสร้าง

- root — frontend: Vanilla TypeScript + Vite (ตาม convention ของ Tauri)
- `src-tauri/` — Tauri v2 desktop shell (Rust)
- `backend/` — Python FastAPI บน `127.0.0.1:8000` (localhost เท่านั้น)

## วิธีติดตั้ง (สำหรับผู้ใช้งาน — ไม่ต้องรู้จัก Terminal)

### ขั้นที่ 1: ดาวน์โหลดตัวติดตั้งจาก GitHub

1. เข้าหน้านี้: **[หน้าดาวน์โหลด (Releases)](../../releases/latest)**
2. เลื่อนลงไปหาหัวข้อ **Assets** แล้วกดโหลดไฟล์ให้ตรงกับเครื่อง:
   - **Windows** → ไฟล์ที่ลงท้าย **`.exe`**
   - **Mac** → ไฟล์ที่ลงท้าย **`.dmg`**
3. ดับเบิลคลิกไฟล์ที่โหลดมาได้เลย (ไม่ต้องแตก zip)

### ขั้นที่ 2: เปิดแอปครั้งแรก (ผ่านคำเตือนความปลอดภัย)

แอปยังไม่ได้เซ็นใบรับรอง (ไม่ได้จ่ายค่า Apple/Microsoft) ครั้งแรกจึงมีคำเตือน — ทำครั้งเดียว:

- **Windows**: ดับเบิลคลิก `.exe` → ถ้าขึ้น **SmartScreen** → คลิก **More info → Run anyway**
  → ถ้าถามอนุญาต firewall สำหรับ localhost → กด **Allow**
- **macOS**: ดับเบิลคลิก `.dmg` → ลากแอปเข้า Applications → **คลิกขวาที่แอป → Open → Open**

### ขั้นที่ 3: เลือกโหมดตามบทบาทของเครื่อง 👇

เปิดแอปครั้งแรกจะเห็น **แถบเหลือง "ติดตั้งโมเดล (~4.4GB)"** — จะกดหรือไม่กดก็ได้
ขึ้นกับว่าเครื่องนี้ทำหน้าที่อะไร:

#### แบบ A — "เครื่องถอดเสียง" (ติดตั้งโมเดล)

สำหรับเครื่องที่ต้อง **ถอดเสียง / ตรึงบท** เอง

1. กดปุ่ม **"ติดตั้งโมเดล"** ในแถบเหลือง → รอดาวน์โหลด ~4.4GB (ครั้งเดียวต่อเครื่อง มีเน็ตตอนนี้เท่านั้น)
2. เสร็จแล้วแถบหายไปเอง → ปุ่ม "ถอดเสียง" และ "ตรึงบท" ใช้ได้
3. หลังจากนี้ **ใช้งานออฟไลน์ 100%** — โมเดลอยู่ในเครื่องแล้ว ไม่ต้องต่อเน็ตอีก
- แนะนำสเปค: RAM 16GB, ดิสก์ว่าง ~6GB, Windows 10/11 แบบ 64-bit

#### แบบ B — "เครื่องตัด/ตรวจงาน" (ไม่ต้องติดตั้งโมเดล)

สำหรับเครื่องที่แค่ **เปิดงานที่คนอื่นถอดมาแล้ว → ฟัง แก้บท ตัด export**

1. **ไม่ต้องกด "ติดตั้งโมเดล"** — ปล่อยแถบเหลืองไว้ (หรือใช้งานทับได้เลย ไม่กวน)
2. กด **"เปิดไฟล์เสียง"** → เลือกไฟล์โปรเจกต์ `.audioedit.json` ที่รับมา
   (ต้องมีไฟล์เสียงต้นฉบับอยู่โฟลเดอร์เดียวกัน)
3. ทำได้ทันทีโดยไม่ต้องมีโมเดล: เล่น, แก้คำ, ซ่อน filler, **ตัดเสียง**, **Export**
- มีแค่ปุ่ม "ถอดเสียง"/"ตรึงบท" ที่เทาอยู่ (ต้องมีโมเดลถึงใช้ได้) — ที่เหลือใช้ได้หมด
- สเปคต่ำได้ RAM 8GB ก็พอ (ไม่มี AI ทำงาน)

### การส่งงานระหว่างเครื่อง

- **ส่งงานทำต่อ**: zip ไฟล์เสียงต้นฉบับ + ไฟล์ `.audioedit.json` (อยู่โฟลเดอร์เดียวกัน)
  → เครื่องปลายทางเปิด .audioedit.json ได้เลย (ไม่ต้องมีโมเดล)
- **ส่งงานจบ**: ใช้ปุ่ม **Export** → ได้เสียง `.wav` ที่ตัดแล้ว + `.docx`/`.txt` เนื้อหาสะอาด

### อัปเดตเวอร์ชันใหม่ (สำหรับเจ้าของ repo)

**push tag เวอร์ชันขึ้นไป** แล้ว CI จะ build ให้เองทั้ง Windows และ macOS
พร้อม **สร้างหน้า Releases** ที่มีตัวติดตั้งแนบไว้ให้ทีมกดโหลดได้เลย:

```sh
# bump เลขเวอร์ชัน 3 ที่ให้ตรงกันก่อน:
#   package.json / src-tauri/tauri.conf.json / backend/app/main.py (APP_VERSION)
git push origin main
git tag -a v1.3.1 -m "..." && git push origin v1.3.1
```

รอ ~20 นาที → หน้า Releases จะมี `.exe` และ `.dmg` โผล่มาเอง
(โมเดลที่ทีมลงไว้แล้วไม่ถูกลบตอนอัปเดต ไม่ต้องโหลด 4.4GB ซ้ำ)

- CI สร้าง backend ด้วย PyInstaller ให้เองอยู่แล้ว (`build.yml`) —
  **ไม่ต้อง build เองก่อน push**
- อยาก build โดยไม่ออก release ก็ได้: **Actions → build-installers →
  Run workflow** จะได้ artifact แบบ zip แทน (ไม่มีหน้า Releases)

## Setup ครั้งแรก (สำหรับนักพัฒนา)

ต้องมี: Node.js 20+, **Python 3.12 ขึ้นไป**, Rust toolchain
(Rust จำเป็นเฉพาะตอน build ตัวแอป — แก้โค้ดกับรัน test ไม่ต้องมี)

> **Python 3.14 ใช้ได้แล้ว** — เดิม README เขียนว่าใช้ไม่ได้เพราะ ctranslate2
> ยังไม่มี wheel ตอนนี้มีครบแล้ว (ctranslate2 4.8.1, torch 2.13, faster-whisper
> 1.2) ตรวจสอบจริงบน Windows + Python 3.14.7 เมื่อ 2026-08-20 เทสต์ผ่านทั้งหมด

**macOS / Linux**

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
npm install                                                      # frontend + tauri

cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/fetch_model.py    # โมเดล ~4.4GB, ครั้งเดียว
```

**Windows** (ลง Rust จาก <https://rustup.rs>)

```sh
npm install

cd backend
py -3 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe scripts/fetch_model.py
```

โมเดลถูกเก็บใน `models/` (gitignored): `asr/thonburian-large-v2/` และ `align/wav2vec2-th/`
สลับโมเดลได้ด้วย env `AUDIOEDIT_MODEL_DIR` / `AUDIOEDIT_ALIGN_MODEL_DIR`

### โมเดลทางเลือก: Pathumma large-v3 (opt-in)

```sh
cd backend && .venv/bin/python scripts/convert_pathumma.py   # download+convert ครั้งเดียว
AUDIOEDIT_MODEL_DIR=../models/asr/pathumma-large-v3 .venv/bin/uvicorn app.main:app
```

⚠ Pathumma ถอดเนื้อหาแม่นกว่า แต่**ตัดคำ filler (เอ่อ/อือ) ทิ้งจาก transcript** —
ทำให้หา filler เพื่อตัดเสียงไม่ได้ จึงไม่ใช่ค่าเริ่มต้น ใช้เมื่อไฟล์นั้นไม่ต้องเก็บ filler

### ปรับความเร็ว ASR (env, มีค่า default ที่ดีแล้ว)

- `AUDIOEDIT_BEAM_SIZE` (default 2), `AUDIOEDIT_BATCH_SIZE` (default 8),
  `AUDIOEDIT_CPU_THREADS` (default 0 = auto)
- ผลวัดจริง (M4 Pro, เสียง 165 วิ): เดิม 629 วิ → ใหม่ 65 วิ (~10 เท่า)

แนะนำให้ `git init` ที่ root ก่อนเริ่มแก้โค้ด

## รัน dev (ใช้ 2 เทอร์มินัล)

```sh
# เทอร์มินัล 1 — backend
cd backend && .venv/bin/uvicorn app.main:app --reload

# เทอร์มินัล 2 — แอปเดสก์ท็อป
npm run tauri dev
```

หน้าต่างแอปจะแสดงสถานะการเชื่อมต่อ backend (เขียว = connected)

## เทส

```sh
npm test                        # frontend (vitest)
cd backend && .venv/bin/pytest  # backend
```

## หมายเหตุ

- ทุกอย่างรันในเครื่อง — backend bind เฉพาะ `127.0.0.1` และ CORS อนุญาตเฉพาะ origin ของ Tauri
- โมเดล ASR/alignment (เฟสถัดไป) จะวางใน `models/` ซึ่งถูก gitignore ไว้ — จะมีเอกสารวิธีดาวน์โหลดเมื่อถึงเฟสนั้น
- Python 3.14 ใช้ได้กับเฟสนี้ แต่เฟส ASR อาจต้องใช้ 3.11–3.12 (ข้อจำกัดของ ctranslate2)
