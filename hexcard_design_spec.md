# HexCard — Sistem Mimarisi ve Tasarım Spesifikasyonu (`v2.0-Argon`)

* **Proje Adı:** HexCard (HyperCard Resurrection & AI-Native Micro-App Studio)
* **Hedef Etkinlik:** Kiroween 2026 Hackathon
* **Birincil Kategori:** **Resurrection** *(Ölü bir teknolojiyi modern çağda yeniden diriltme)*
* **İkincil Kategoriler:** **Costume Contest** *(Otantik 1987 Macintosh System 7 / 1-bit Dithered GUI)* & **Frankenstein** *(80'lerin yerel masaüstü kart mimarisi + 2026 LLM AST derleyicisi + Canvas2D/WebGL + WebAudio sentezleyici birleşimi)*
* **Hedef Platform:** Web (Zero-Backend İstemci Çalışma Zamanı + Tek Dosya HTML/JSON Dağıtımı) ve Masaüstü (Tauri v2 sarmalayıcı uyumlu)

---

## 1. Ürün Vizyonu ve Temel Mühendislik Felsefesi

1987 yılında Bill Atkinson tarafından geliştirilen Apple HyperCard, programlama bilmeyen kullanıcıların bile "Kart Desteleri" (Stacks) metaforuyla veritabanları, etkileşimli kurgu oyunları (*Myst* ve *The Manhole* gibi), eğitim yazılımları ve arayüz prototipleri geliştirmesini sağlayan devrimsel bir "yazılım inşa kiti" idi.

**HexCard**, HyperCard'ı basit bir slayt gösterisi olmaktan çıkaran gerçek mimari derinliğini koruyarak 2026 standartlarında yeniden diriltir:

1. **Sıfır Derleme Süresi (Immediate Mode Authoring):** Tasarım modu ile çalışma zamanı arasında ayrım yoktur. Kullanıcı araç paletinden **Browse (El)** aracını seçtiği saniye uygulama canlıdır; **Button**, **Field** veya **Paint** araçlarından birini seçtiği saniye arayüzü ve mantığı canlı olarak düzenler.
2. **Arka Plan Mirası (Background Layer Inheritance) ve `sharedText` Semantiği:** Kartlar birbirinden kopuk sayfalar değildir; ortak bir `HexBackground` şablonunu (grafik, buton ve metin alanlarını) paylaşırlar. Arka plandaki bir metin alanı tüm kartlarda aynı konumda görünür ancak `sharedText: false` ise her kart kendi verisini tutar (veritabanı kaydı mantığı), `sharedText: true` ise tüm kartlarda aynı sabit metni gösterir.
3. **Halüsinasyonsuz Doğal Dil Programlama (NL-to-HexAST):** Kullanıcı bir bileşene sağ tıklayıp *"Tıklandığında 3. karta 'dissolve' efektiyle geç, skoru 10 artır ve 'harpsichord' sesiyle C4-E4-G4 notalarını çal"* yazdığında, AI katmanı bunu doğrudan güvenli ve deterministik bir **HexScriptAST** (Soyut Sözdizimi Ağacı) yapısına ve okunabilir **HexTalk** koduna derler.
4. **Matematiksel 1-Bit Piksel Sadakati:** Görsel motor CSS filtreleriyle sahte bir retro görünüm vermez; Bill Atkinson'ın orijinal hata yayılım (dithering) algoritmasını, 38 klasik Macintosh `8x8` bit desenini ve **Galois LFSR (Linear Feedback Shift Register)** tabanlı gerçek piksel çözünme (`dissolve`) geçişlerini çalıştırır.

---

## 2. Çekirdek Veri Modeli ve 5 Katmanlı Mimari

HexCard'ın çalışma zamanı hiyerarşisi 5 katmandan oluşur:

~~~text
[ HexStack (Deste / Uygulama Kökü) ]
   ├── Global Durum (Değişkenler, Özel İkonlar, Ses Bankaları, Tema Paleti)
   ├── [ HexBackground (Paylaşılan Şablon Katmanı - 1..N) ]
   │      ├── Background Bitmap Layer (512x342 1-bit paylaşılan piksel sanatı)
   │      ├── Background Parts (Tüm kartlarda görünen ortak Butonlar / Alanlar)
   │      └── Background Script (Alt kartların miras aldığı ortak olay işleyiciler)
   └── [ HexCard (Tekil Ekran / Kayıt Katmanı - 1..M, bir Background'a bağlı) ]
          ├── Card Bitmap Layer (512x342 1-bit karta özel şeffaf/maskeli piksel sanatı)
          ├── Background Field Overrides (sharedText: false olan alanların bu karta özel verisi)
          ├── Card Parts (Yalnızca bu kartta görünen özel Butonlar / Alanlar / Widget'lar)
          └── Card Script (Bu karta özel olay işleyiciler)
~~~

### 2.1. Kesin TypeScript Veri Şeması (`src/core/schema.ts`)

~~~typescript
export type HexID = string; // Format: "stk_...", "bkg_...", "crd_...", "prt_..."

export type VisualEffectType =
  | "cut"
  | "dissolve"         // 18-bit Galois LFSR sözde-rastgele piksel çözünmesi
  | "venetianBlinds"   // Yatay panjur şerit açılması
  | "checkerboard"     // 8x8 dama tahtası geçişi
  | "irisOpen"         // Merkezden dışa dikdörtgen açılma
  | "irisClose"        // Dıştan merkeze kapanma
  | "wipeLeft"
  | "wipeRight"
  | "wipeUp"
  | "wipeDown"
  | "barnDoorOpen"
  | "barnDoorClose";

export type VisualEffectSpeed = "verySlow" | "slow" | "normal" | "fast";

export type AuthoringTool =
  | "browse"      // Etkileşim modu (El ikonu)
  | "button"      // Buton seçme/oluşturma/boyutlandırma aracı
  | "field"       // Metin alanı seçme/oluşturma/boyutlandırma aracı
  | "select"      // Dikdörtgen piksel seçimi (Marquee)
  | "lasso"       // Serbest biçimli piksel seçimi
  | "pencil"      // 1-piksel çizim (FatBits yakınlaştırma destekli)
  | "brush"       // Seçili 8x8 bit deseniyle boyama
  | "eraser"      // Piksel silici (Card katmanında şeffafa, Background'da beyaza siler)
  | "line"        // Bresenham algoritmalı 1-bit doğru çizimi
  | "spray"       // Rastgele matris dağılımlı sprey
  | "rect"        // Dikdörtgen çerçeve / dolgulu kutu çizimi
  | "paintBucket"; // 4-yönlü Flood-Fill algoritması ile 8x8 desen doldurma

export interface HexBitmapLayer {
  width: number;  // Standart: 512
  height: number; // Standart: 342
  /**
   * RLE (Run-Length Encoding) + Base64 sıkıştırılmış 1-bit renk ve 1-bit maske verisi.
   * Çalışma zamanında Uint8Array (0 = Şeffaf, 1 = Beyaz/Opak, 2 = Siyah/Opak) olarak açılır.
   */
  rleData: string;
}

export type PartType = "button" | "field" | "canvasWidget" | "timer";

export type ButtonStyle =
  | "transparent"
  | "opaque"
  | "rectangle"
  | "roundRect"     // Klasik Mac yuvarlatılmış köşe buton
  | "shadow"        // Alt ve sağ kenarda 2px siyah düşen gölgeli buton
  | "checkBox"
  | "radioButton"
  | "default";      // Çift siyah çerçeveli ana aksiyon butonu

export type FieldStyle =
  | "transparent"
  | "opaque"
  | "rectangle"
  | "shadow"
  | "scrolling";    // Klasik Mac 1-bit oklu kaydırma çubuklu metin kutusu

export interface HexRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HexPartBase {
  id: HexID;
  name: string;
  type: PartType;
  layerScope: "card" | "background";
  rect: HexRect;
  visible: boolean;
  enabled: boolean;
  scriptSource: string;           // İnsan tarafından okunabilir HexTalk kaynak kodu
  naturalLanguagePrompt?: string; // Kullanıcının girdiği son AI komutu
  compiledAst: HexScriptAST;      // Sanal makine tarafından yürütülen deterministik AST
}

export interface HexButtonPart extends HexPartBase {
  type: "button";
  style: ButtonStyle;
  title: string;
  showName: boolean;
  iconId?: string;                // 32x32 1-bit sprite ikonu referansı
  autoHilite: boolean;            // Tıklandığında siyah/beyaz pikselleri ters çevir (invert)
  hilite: boolean;                // Checkbox/Radio seçili durumu
  family?: number;                // 1-15 arası Radio Button dışlayıcı grup numarası
}

export interface HexFieldPart extends HexPartBase {
  type: "field";
  style: FieldStyle;
  content: string;                // sharedText: true ise veya Card katmanındaysa buradaki metin okunur
  sharedText: boolean;            // false ise ve Background katmanındaysa metin HexCard.bgFieldContents içinde tutulur
  lockText: boolean;              // true ise Browse modunda kullanıcı metni düzenleyemez, tıklama olayları tetiklenir
  dontWrap: boolean;
  showLines: boolean;             // Klasik noktalı defter satır çizgileri
  textAlign: "left" | "center" | "right";
  textFont: "Chicago" | "Geneva" | "Monaco" | "NewYork";
  textSize: 9 | 10 | 12 | 14 | 18 | 24;
  textStyle: Array<"bold" | "italic" | "underline" | "outline" | "shadow" | "condense">;
}

export type HexPart = HexButtonPart | HexFieldPart;

export interface HexBackground {
  id: HexID;
  name: string;
  bitmap: HexBitmapLayer;
  parts: HexPart[];               // layerScope === "background"
  scriptSource: string;
  compiledAst: HexScriptAST;
  cantDelete: boolean;
}

export interface HexCard {
  id: HexID;
  name: string;
  backgroundId: HexID;            // Miras alınan HexBackground referansı
  bitmap: HexBitmapLayer;         // Arka planın üzerine binen şeffaf/maskeli kart çizimi
  parts: HexPart[];               // layerScope === "card"
  /**
   * Arka planda tanımlı olup sharedText === false olan alanların
   * bu karta özel metin içeriklerini tutan eşleme tablosu (Key: Part.id, Value: string)
   */
  bgFieldContents: Record<HexID, string>;
  marked: boolean;                // Filtreleme ve "go to next marked card" sorguları için
  cantDelete: boolean;
  dontSearch: boolean;
  scriptSource: string;
  compiledAst: HexScriptAST;
}

export interface HexStack {
  id: HexID;
  schemaVersion: "2.0.0";
  name: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  dimensions: { width: number; height: number }; // Varsayılan: 512 x 342
  themePalette: {
    name: "ClassicPaper" | "AmberCRT" | "GreenPhosphor" | "MidnightHex";
    darkBitHex: string;           // Classic: "#000000" | Amber: "#1A1000" | Green: "#041804"
    lightBitHex: string;          // Classic: "#FFFFFF" | Amber: "#FFB000" | Green: "#33FF33"
  };
  backgrounds: HexBackground[];
  cards: HexCard[];               // Sıralı kart dizisi (Index 0 = First Card)
  customIcons: Record<string, string>; // 32x32 1-bit Base64 ikon kütüphanesi
  scriptSource: string;
  compiledAst: HexScriptAST;
}
~~~

---

## 3. Olay Zinciri ve Mesaj İletim Hiyerarşisi (The Message Path)

HyperCard mimarisinde her etkileşim bir **Mesaj (Message)** üretir. Bir bileşen bu mesajı yakalamazsa veya açıkça `pass <eventName>` çağrısı yaparsa, mesaj otomatik olarak bir üst katmana kabarcıklanır (event bubbling):

~~~text
[ Kullanıcı Tıklaması / Klavye / Sistem Yaşam Döngüsü Olayı ]
         │
         ▼
1. Hedef Bileşen (HexPart: Button veya lockText=true olan Field)
         │  (İşleyici yoksa veya "pass" edildiyse)
         ▼
2. Aktif Kart (HexCard)
         │  (İşleyici yoksa veya "pass" edildiyse)
         ▼
3. Aktif Arka Plan (HexBackground)
         │  (İşleyici yoksa veya "pass" edildiyse)
         ▼
4. Aktif Deste (HexStack)
         │  (İşleyici yoksa veya "pass" edildiyse)
         ▼
5. HexEngine Yerleşik Çalışma Zamanı (Built-in Runtime Handlers)
~~~

### 3.1. Desteklenen Sistem Olayları
* **Fare Etkileşimleri:** `mouseDown`, `mouseStillDown`, `mouseUp`, `mouseEnter`, `mouseWithin`, `mouseLeave`, `mouseDoubleClick`
* **Yaşam Döngüsü (Lifecycle):** `openStack`, `closeStack`, `openBackground`, `closeBackground`, `openCard`, `closeCard`, `newCard`, `deleteCard`
* **Veri Alanı ve Klavye:** `openField`, `closeField` (içerik değişip çıkıldığında), `exitField` (değişiklik olmadan çıkıldığında), `keyDown`, `returnInField`, `enterInField`
* **Oyun ve Animasyon Döngüsü:** `idle` (Browse modunda aktif bir betik çalışmıyorken her 200ms'de bir tetiklenen arka plan döngüsü)

---

## 4. HexTalk / HexAST Deterministik Çalışma Zamanı ve AI Derleyici

Güvenlik ve kararlılık için HexCard, kullanıcı betiklerini veya yapay zeka çıktılarını **asla `eval()` veya `new Function()` ile çalıştırmaz**. Tüm mantık, deterministik bir Soyut Sözdizimi Ağacı (**HexScriptAST**) üzerinde çalışan adım bütçeli (gas-limited) bir sanal makine tarafından yürütülür.

### 4.1. HexTalk EBNF Dilbilgisi Özeti

~~~ebnf
Script        ::= { Handler } ;
Handler       ::= "on" Identifier [ IdentifierList ] Newline { Statement } "end" Identifier ;
Statement     ::= GoCmd | PutCmd | SetCmd | AddSubCmd | VisualCmd | PlayCmd
                | AnswerCmd | AskCmd | WaitCmd | FetchCmd | IfBlock | RepeatBlock | PassCmd ;

GoCmd         ::= "go" [ "to" ] ( "next" "card" | "prev" "card" | "first" "card" | "last" "card"
                | "card" Expression ) ;
VisualCmd     ::= "visual" [ "effect" ] EffectName [ SpeedName ] ;
PutCmd        ::= "put" Expression ( "into" | "after" | "before" ) TargetContainer ;
AddSubCmd     ::= ( "add" Expression "to" | "subtract" Expression "from" ) TargetContainer ;
SetCmd        ::= "set" [ "the" ] PropertyName "of" ObjectSpec "to" Expression ;
PlayCmd       ::= "play" SoundVoice [ "tempo" Number ] NoteSequenceString ;
AnswerCmd     ::= "answer" Expression [ "with" Expression [ "or" Expression [ "or" Expression ] ] ] ;
AskCmd        ::= "ask" Expression [ "with" Expression ] ;
FetchCmd      ::= "fetch" Expression "into" TargetContainer ;
IfBlock       ::= "if" Expression "then" Newline { Statement } [ "else" Newline { Statement } ] "end" "if" ;
RepeatBlock   ::= "repeat" ( "with" Identifier "=" Expression "to" Expression | "while" Expression | Expression [ "times" ] )
                  Newline { Statement } "end" "repeat" ;
PassCmd       ::= "pass" Identifier ;
~~~

### 4.2. Deterministik AST Şeması (`src/core/ast.ts`)

~~~typescript
export interface HexScriptAST {
  handlers: Record<string, HexHandlerNode>; // Örn: { "mouseup": HexHandlerNode, "opencard": HexHandlerNode }
}

export interface HexHandlerNode {
  eventName: string;
  params: string[];
  body: HexStatementNode[];
}

export type HexStatementNode =
  | {
      kind: "GoToCard";
      target:
        | { type: "relative"; dir: "next" | "prev" | "first" | "last" | "back" }
        | { type: "id" | "name" | "index"; value: HexExprNode };
    }
  | { kind: "QueueVisualEffect"; effect: VisualEffectType; speed: VisualEffectSpeed }
  | { kind: "PutValue"; mode: "into" | "after" | "before"; value: HexExprNode; destination: HexContainerTarget }
  | { kind: "MathMutation"; op: "add" | "subtract" | "multiply" | "divide"; amount: HexExprNode; destination: HexContainerTarget }
  | { kind: "SetProperty"; property: string; target: HexObjectTarget; value: HexExprNode }
  | { kind: "PlaySound"; voice: "harpsichord" | "boing" | "flute" | "square8bit" | "click"; tempo: number; notes: string }
  | { kind: "ShowAnswerDialog"; prompt: HexExprNode; buttons: HexExprNode[] } // Seçilen butonu "it" değişkenine yazar
  | { kind: "ShowAskDialog"; prompt: HexExprNode; defaultAnswer?: HexExprNode } // Girilen metni "it" değişkenine yazar
  | { kind: "Wait"; ticks: HexExprNode } // 1 tick = 1/60 saniye (16.67ms)
  | { kind: "FetchJson"; url: HexExprNode; jsonPath?: string; destination: HexContainerTarget }
  | { kind: "IfCondition"; condition: HexExprNode; thenBranch: HexStatementNode[]; elseBranch?: HexStatementNode[] }
  | {
      kind: "RepeatLoop";
      loopType: "count" | "while" | "range";
      varName?: string;
      start?: HexExprNode;
      end?: HexExprNode;
      condition?: HexExprNode;
      body: HexStatementNode[];
    }
  | { kind: "PassEvent"; eventName: string };

export type HexContainerTarget =
  | { scope: "variable"; name: string } // "it" yerel değişkeni dahil
  | { scope: "field"; layer: "card" | "background"; identifier: string | number };

export type HexObjectTarget =
  | { objectType: "button" | "field"; layer: "card" | "background"; identifier: string | number }
  | { objectType: "card" | "background" | "stack"; identifier?: string | number };

export type HexExprNode =
  | { kind: "Literal"; value: string | number | boolean }
  | { kind: "Variable"; name: string } // "it", "the date", "the time", "the mouseH", "the mouseV", "the random of N"
  | { kind: "ReadContainer"; source: HexContainerTarget }
  | { kind: "ReadProperty"; property: string; target: HexObjectTarget }
  | {
      kind: "BinaryOp";
      op: "+" | "-" | "*" | "/" | "mod" | "&&" | "&" | "=" | "!=" | "isGreaterThan" | "isLessThan" | "contains" | "and" | "or";
      left: HexExprNode;
      right: HexExprNode;
    }
  | { kind: "UnaryOp"; op: "not" | "-"; operand: HexExprNode };
~~~

### 4.3. Sanal Makine Güvenlik Kuralları (Sandbox Guardrails)
* **Adım Bütçesi (Instruction Gas Limit):** Her olay tetiklemesi maksimum `10.000` AST düğümü yürütebilir. Limit aşılırsa sanal makine işlemi durdurur, mevcut yığın durumunu korur ve klasik System 7 bomba ikonlu hata penceresini (*"Sorry, a script error occurred: Loop exceeded 10,000 steps"*) gösterir.
* **Özel `"it"` Değişkeni:** HyperCard geleneğine uygun olarak `ask`, `answer`, `get` ve `fetch` komutları sonuçlarını her zaman aktif işleyicinin yerel `it` değişkenine yazar.
* **Çift Yönlü Senkronizasyon (NL <-> HexTalk <-> HexAST):** Kullanıcı doğal dilde bir komut girdiğinde LLM hem `HexScriptAST` JSON çıktısını hem de insan tarafından okunabilir `HexTalk` kodunu üretir; kullanıcı `HexTalk` kodunu elle düzenlediğinde yerleşik ayrıştırıcı (`parser.ts`) AST'yi anında günceller.

---

## 5. Görsel Motor: 1-Bit Estetik, Atkinson Dithering ve Geçiş Algoritmaları

### 5.1. Bill Atkinson Dithering Algoritması (`src/engine/graphics/atkinsonDither.ts`)
Kullanıcı renkli bir görseli sürükleyip bıraktığında veya AI ile görsel ürettiğinde, görüntü `512x342` çözünürlüğe ölçeklenir ve Bill Atkinson'ın orijinal hata yayılım matrisi ile 1-bit piksellere dönüştürülür. Floyd-Steinberg algoritmasının aksine Atkinson algoritması niceleme hatasının yalnızca **6/8'ini (%75)** komşu piksellere dağıtır; bu sayede 1-bit ekranda çamurlaşma önlenir ve yüksek kontrastlı net kenarlar elde edilir:

~~~text
          [ * ]   1/8    1/8
   1/8     1/8    1/8
           1/8
~~~

~~~typescript
export function applyAtkinsonDithering(
  grayscaleBuffer: Float32Array,
  width: number,
  height: number,
  threshold = 128
): Uint8Array {
  const out = new Uint8Array(width * height);
  const lum = new Float32Array(grayscaleBuffer);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = lum[idx];
      const newPixel = oldPixel < threshold ? 0 : 255;
      out[idx] = newPixel === 0 ? 2 : 1; // 2 = Siyah Bit, 1 = Beyaz Bit

      const err = (oldPixel - newPixel) / 8; // Hatanın 1/8'i

      if (x + 1 < width) lum[idx + 1] += err;
      if (x + 2 < width) lum[idx + 2] += err;
      if (y + 1 < height) {
        if (x - 1 >= 0) lum[(y + 1) * width + (x - 1)] += err;
        lum[(y + 1) * width + x] += err;
        if (x + 1 < width) lum[(y + 1) * width + (x + 1)] += err;
      }
      if (y + 2 < height) {
        lum[(y + 2) * width + x] += err;
      }
    }
  }
  return out;
}
~~~

### 5.2. Galois LFSR Tabanlı Gerçek `visual effect dissolve` (`src/engine/graphics/lfsrDissolve.ts`)
1-bit ekranda gri ton veya yarı saydamlık (alpha blending) olmadığı için kartlar arası `dissolve` geçişi **18-bit Galois Doğrusal Geri Beslemeli Kaydırma Yazmacı (LFSR)** ile yapılır. Bu algoritma `512 x 342 = 175.104` pikselin tamamını hiçbir pikseli iki kez ziyaret etmeden sözde-rastgele sırayla eski karttan yeni karta kopyalar:

~~~typescript
// 18-bit maksimal periyotlu (2^18 - 1 = 262.143) Galois LFSR polinom maskesi: 0x20400
export function stepDissolveFrame(
  currentFrameBuffer: Uint32Array,
  targetFrameBuffer: Uint32Array,
  totalPixels: number,
  lfsrStateRef: { state: number },
  pixelsPerFrame: number
): boolean {
  let state = lfsrStateRef.state;
  let copied = 0;

  while (copied < pixelsPerFrame) {
    const lsb = state & 1;
    state >>= 1;
    if (lsb !== 0) {
      state ^= 0x20400; // 18-bit maximal length tap
    }
    if (state < totalPixels) {
      currentFrameBuffer[state] = targetFrameBuffer[state];
      copied++;
    }
    if (state === 1) {
      currentFrameBuffer[0] = targetFrameBuffer[0];
      lfsrStateRef.state = 1;
      return true; // Geçiş tamamlandı
    }
  }
  lfsrStateRef.state = state;
  return false;
}
~~~

### 5.3. Dünya Uzayına Kilitli 8x8 Bit Desenleri (`src/engine/graphics/patterns.ts`)
Boya kovası ve fırça araçları her biri 8 baytlık (`Uint8Array(8)`) bit maskesiyle tanımlanan 38 klasik Macintosh desenini kullanır. Desen biti `const bit = (pattern[y & 7] >> (7 - (x & 7))) & 1;` formülüyle doğrudan tuval koordinatlarına kilitlenir; böylece üst üste binen fırça darbelerinde desen kayması yaşanmaz.

---

## 6. WebAudio Prosedürel Ses Sentezleyici (`src/engine/audio/synth.ts`)

Harici MP3/WAV dosyalarına ihtiyaç duymadan tamamen `AudioContext` üzerinde çalışan prosedürel ses motoru:
1. **`harpsichord`:** Karplus-Strong telli çalgı fiziksel modelleme algoritması (kısa gürültü patlaması + alçak geçiren geri beslemeli gecikme hattı) ile otantik 1987 klavsen tınısı üretir.
2. **`boing`:** Sinüs osilatörü üzerinde üstel perde kaydırma (pitch envelope) ve düşük frekanslı modülasyon (LFO) uygular.
3. **`flute` & `square8bit`:** ADSR zarflı üçgen ve darbe genişlik modülasyonlu (PWM) kare dalga sentezleyicileri.
4. **Nota Dizisi Çözümleyici:** `play "harpsichord" tempo 140 "c4q e4q g4h c5w"` formatındaki dizileri milisaniye hassasiyetinde zamanlayarak çalar (`w`=birlik, `h`=ikilik, `q`=dörtlük, `e`=sekizlik, `s`=onaltılık, `.`=noktalı uzatma).

---

## 7. Kullanıcı Arayüzü (System 7 GUI) ve Çift Modlu Yazarlık Mimarisi

1. **Üst Menü Çubuğu:** `Hex`, `File`, `Edit`, `Go`, `Tools`, `Objects`, `Paint` ve `AI Conjure` menülerini barındırır.
2. **Koparılabilir Araç Paleti (Tear-Off Floating Tools Palette):** Kullanıcı `Tools` menüsünü aşağı doğru sürüklediğinde menü koparak ekranda taşınabilir 12 araçlık sabit bir palet penceresine dönüşür.
3. **Arka Plan Düzenleme Modu (`Edit Background` / `Cmd+B`):** Aktif edildiğinde menü çubuğunun çevresinde klasik **kalın diyagonal şeritler (hash marks)** belirir. Bu modda yapılan tüm çizimler ve eklenen tüm bileşenler doğrudan aktif `HexBackground` katmanına kaydedilir.
4. **Bileşen Denetçisi (Object Inspector) ve HexAI Spellcaster:** Bir butona veya alana çift tıklandığında açılan modal pencerede bileşenin görsel özellikleri, **HexTalk** kod editörü ve doğal dilden AST üreten **HexAI Spellcaster** istem kutusu yer alır.
5. **Görsel Deste Haritası (Stack Graph Modal):** Destedeki tüm kartları minyatür 1-bit önizlemeleriyle ve aralarındaki `GoToCard` oklarıyla birlikte etkileşimli bir düğüm grafiği olarak çizer.

---

## 8. Kiro IDE Entegrasyon Spesifikasyonu (`.kiro/` Dizin Yapısı)

Kiroween değerlendirme kriterlerine tam uyum sağlamak için proje kök dizininde aşağıdaki `.kiro` mimarisi kullanılır:

~~~text
.kiro/
├── steering/
│   ├── product.md               # Ürün vizyonu, 5 katmanlı HyperCard kuralları ve terimler sözlüğü
│   ├── tech.md                  # Teknoloji yığını, 1-bit render kısıtları, eval() yasağı
│   └── structure.md             # Modül sınırları ve katmanlı mimari kuralları
├── specs/
│   ├── 01-core-stack-engine/
│   │   ├── requirements.md      # EARS notasyonlu kabul kriterleri
│   │   ├── design.md            # Veri yapıları ve mesaj iletim diyagramları
│   │   └── tasks.md             # İzlenebilir alt görev listesi
│   ├── 02-hextalk-ast-vm/
│   │   ├── requirements.md
│   │   ├── design.md
│   │   └── tasks.md
│   └── 03-1bit-canvas-dither/
│       ├── requirements.md
│       ├── design.md
│       └── tasks.md
└── hooks/
    ├── validate-ast-safety.json # src/core/** değiştiğinde eval() yasağını ve VM adım limitini denetler
    └── enforce-1bit-ui.json     # src/ui/** değiştiğinde bulanık gölge/gradyan kullanımını engeller
~~~

### 8.1. EARS Notasyonlu Gereksinim Şablonu (`.kiro/specs/01-core-stack-engine/requirements.md`)

~~~markdown
# Requirements: Core Stack & Message Passing Engine

## REQ-1: Background Layer Inheritance & SharedText Semantics
- **User Story:** Bir deste tasarımcısı olarak, birden fazla kartın ortak bir arka plan şablonunu paylaşmasını ancak veri alanlarının karta özel metin tutabilmesini istiyorum.
- **Acceptance Criteria (EARS):**
  1. WHEN a `HexCard` is rendered, THE SYSTEM SHALL composite the linked `HexBackground` bitmap and background parts underneath the card's own bitmap and card parts.
  2. WHERE a background `HexFieldPart` has `sharedText` set to `false`, WHEN the user or a script modifies the field's text on a specific card, THE SYSTEM SHALL store and retrieve the text from `HexCard.bgFieldContents[fieldId]` without mutating other cards sharing that background.
  3. WHERE a background `HexFieldPart` has `sharedText` set to `true`, WHEN the field's text is modified on any card, THE SYSTEM SHALL update `HexFieldPart.content` on the `HexBackground` so all cards sharing that background reflect the change immediately.

## REQ-2: Deterministic Message Passing Hierarchy
- **User Story:** Bir uygulama geliştiricisi olarak, bir bileşende işlenmeyen olayların otomatik olarak Kart, Arka Plan ve Deste katmanlarına iletilmesini istiyorum.
- **Acceptance Criteria (EARS):**
  1. WHEN an interaction event (e.g., `mouseUp`) is triggered on a `HexPart` while the active tool is `browse`, THE SYSTEM SHALL execute the matching handler in `HexPart.compiledAst` if defined.
  2. IF the target `HexPart` does not define a handler for the event OR executes a `PassEvent` statement, THEN THE SYSTEM SHALL propagate the event up the hierarchy in the exact order: `HexCard` -> `HexBackground` -> `HexStack` -> `HexRuntimeBuiltIns`.

## REQ-3: Step-Budgeted Sandboxed Execution
- **User Story:** Bir platform kullanıcısı olarak, hatalı veya sonsuz döngü içeren kart betiklerinin tarayıcıyı dondurmamasını istiyorum.
- **Acceptance Criteria (EARS):**
  1. WHILE the HexAST Virtual Machine is executing an event handler chain, THE SYSTEM SHALL increment an instruction counter for every evaluated AST node.
  2. IF the instruction counter exceeds `10,000` steps within a single event dispatch, THEN THE SYSTEM SHALL halt execution immediately, preserve current stack state, and display a retro System 7 script error modal pointing to the offending handler.
~~~

### 8.2. Kiro Agent Hook Tanımı (`.kiro/hooks/validate-ast-safety.json`)

~~~json
{
  "name": "Validate HexAST Sandbox & Schema Integrity",
  "description": "Çekirdek VM ve AST dosyaları güncellendiğinde dinamik kod yürütme (eval/Function) olmadığını ve birim testlerinin geçtiğini doğrular.",
  "trigger": {
    "type": "file_save",
    "patterns": ["src/core/**/*.ts", "src/ai/**/*.ts"]
  },
  "action": {
    "type": "agent_prompt",
    "prompt": "İlgili dosyayı incele: 1) Hiçbir koşulda eval(), new Function() veya güvensiz DOM enjeksiyonu kullanılmadığını doğrula. 2) Yeni eklenen AST düğümlerinin src/core/vm.ts içerisindeki instruction gas-limit sayacını artırdığından emin ol. 3) Uyumsuzluk varsa düzelt."
  }
}
~~~

---

## 9. Uygulama Dizin Yapısı ve Jüri Vitrin Desteleri (Showcase Stacks)

~~~text
hexcard/
├── .kiro/                         # Kiro Spec, Steering ve Hook dosyaları
├── src/
│   ├── core/
│   │   ├── schema.ts              # Stack, Background, Card, Part veri modelleri
│   │   ├── ast.ts                 # HexScriptAST düğüm tipleri
│   │   ├── vm.ts                  # Adım bütçeli (gas-limited) asenkron AST yorumlayıcısı
│   │   ├── parser.ts              # HexTalk <-> HexScriptAST çift yönlü dönüştürücü
│   │   ├── messageBus.ts          # Part -> Card -> Background -> Stack olay kabarcıklanması
│   │   └── history.ts             # 50 adımlı Undo/Redo Command Pattern halka tamponu
│   ├── engine/
│   │   ├── graphics/
│   │   │   ├── bitmapCanvas.ts    # 512x342 1-bit çift katmanlı (Background + Card) birleştirici
│   │   │   ├── atkinsonDither.ts  # Görsel içe aktarma için Bill Atkinson hata yayılım motoru
│   │   │   ├── patterns.ts        # 38 adet 8x8 klasik Mac bit maskesi ve flood-fill
│   │   │   └── lfsrDissolve.ts    # Galois LFSR Dissolve, Venetian Blinds, Iris, Checkerboard
│   │   └── audio/
│   │       └── synth.ts           # WebAudio Karplus-Strong Harpsichord & 8-bit ses sentezleyici
│   ├── ai/
│   │   ├── spellcaster.ts         # Doğal dil promptlarını deterministik HexScriptAST'ye derleyen servis
│   │   └── stackGenerator.ts      # Tek prompt ile tam bir çok kartlı mikro uygulama/oyun üreteci
│   ├── storage/
│   │   ├── indexedDb.ts           # Yerel otomatik kayıt
│   │   ├── urlCodec.ts            # Sıkıştırılmış URL Hash üzerinden sunucusuz paylaşım
│   │   └── htmlExporter.ts        # Desteyi tek başına çalışan bağımsız .html dosyasına paketleyici
│   ├── presets/
│   │   ├── hauntedMansion.ts      # 1) "The Haunted Stack of 1987": 1-bit korku/bulmaca macera oyunu
│   │   ├── retroSynthDeck.ts      # 2) "HexSynth Sequencer": Klavsen ve 8-bit müzik sıralayıcı
│   │   └── apiWeatherOracle.ts    # 3) "MacOracle 1987": Canlı veri çeken retro masaüstü paneli
│   └── ui/
│       ├── System7Shell.tsx       # Menü çubuğu, pencere çerçevesi ve CRT/Klasik tema değiştirici
│       ├── FloatingTools.tsx      # Koparılabilir 12 araçlı klasik HyperCard paleti
│       ├── CardViewport.tsx       # Canvas + Etkileşimli Part katmanı
│       ├── ObjectInspector.tsx    # Özellik düzenleyici + HexAI Spellcaster arayüzü
│       └── StackGraphModal.tsx    # Kartlar arası görsel düğüm haritası
└── package.json
~~~