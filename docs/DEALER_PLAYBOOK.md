# Dealer Operations Manual

*The end-user guide to running your development on the lot management platform: branding, lot maps, website embeds, payment receipts, and the morning brief.*

---

## Part 1 — Getting Started & Branding

### Logging in

1. Open your platform address in a browser and go to **/admin**.
2. Sign in with the staff email and password provided during setup.
3. If you see *"Your login does not have an admin profile,"* ask your system administrator to add your account — you will not be able to proceed until they do.

There are four access levels. Most day-to-day work happens as **Staff**; user management and system settings require **Admin** or **Super Admin**.

### Setting up your company details

1. In the left navigation, open **Settings**, then the **Company Profile** tab.
2. Fill in your **company name, address, contact email, phone number, website**, and a short public description of the development.
3. Upload your **logo** (JPG, PNG, or WEBP). It appears across the platform, on buyer documents, and in emails.
4. Press **Save**. The public application page, emails, and printed documents pick up these details automatically — you never need to edit them in more than one place.

### Uploading your subdivision aerial map

1. In **Settings → Company Profile**, find the **Site Masterplan Map** card.
2. Choose your clearest top-down image of the full subdivision — a high-resolution **JPG, PNG, or WEBP under 10MB** works best. Drone shots and updated survey drawings are ideal; phone photos of paper plans are not.
3. You can drag the file onto the upload box or use the file picker. A preview shows the exact pixel dimensions so you can confirm sharpness before publishing.
4. Press **Upload New Map**, check how your lot boundaries line up over it in the preview, then **Publish & Activate Version**.
5. To withdraw a map without deleting its history, use **Remove Map**. Earlier versions stay saved and can be reactivated at any time.

---

## Part 2 — Lot Mapping & Pricing

### Drawing lot boundaries

1. Open **Lots** to see every parcel as a tile, color-coded by status: **green = Available, amber = Reserved, red = Sold**.
2. Click any lot tile to open its editor, then switch to the **Map Boundary** tab.
3. At the top of the map, choose **Draw** mode and click around the lot's outline on the aerial photo to drop corner points. Click near your starting point to finish the shape (three corners minimum).
4. Switch to **Edit** mode to drag any corner into place. Double-click a corner to remove it.
5. **Select** mode is for inspecting: click any outlined lot to see its number, size, price, and status.
6. Press **Save polygon**. To start over, use **Clear polygon**.

### Getting precise boundaries

* Turn on **Snap-to-grid** to align corners to a tidy grid — helpful for rectangular subdivision layouts.
* Zoom in (up to 4×) and pan around large maps to place corners accurately, then reset the view when done.
* Every other lot's outline shows faintly behind the one you are editing, so shared boundary lines are easy to match — draw one side once and mirror it on the neighbor.
* Boundaries are stored as relative positions, so they stay glued to the right spot on phones, tablets, and desktops alike.

### Updating the map image safely

1. When a sharper drone shot or revised drawing arrives, upload it from the **Site Masterplan Map** card. It arrives as an **inactive draft** — your live map does not change.
2. Before publishing, open the draft's **Preview**. All existing lot outlines draw over the candidate image.
3. Drag the **opacity slider** to fade between the photo and the outlines, and flip on **Compare with current active** to jump between the old and new images.
4. Only when every boundary sits correctly, press **Publish & Activate Version**. The previous image stays in **Version History** with its upload date, so rolling back is one **Activate** click on the older version.

### Pricing a lot

In the lot editor's **Details** tab, set the **status** (Available / Reserved / Sold), **base price**, and **dimensions**, then **Save details**. Prices marked visible in *Public Application Settings* appear on your website map automatically.

---

## Part 3 — Website Embeds & Public Integration

### Generating your embed code

1. Open **Settings → Website Integration & Embeds**.
2. Tune the live map to taste: **height** (e.g. 700px), **corner rounding**, and the **default view** (all lots, or available-only for a sales-focused page).
3. Press **Copy to Clipboard**. You get a ready-made snippet that always shows your current lots, prices, and boundaries — no updates needed when inventory changes.

### Adding it to WordPress or Webflow

* **WordPress:** edit the page, add a **Custom HTML** block, paste the snippet, and update the page.
* **Webflow:** add an **Embed** element, paste the snippet, and publish.
* Any site builder that accepts raw HTML works the same way. The map fills its container width and scrolls internally, so it behaves on mobile without extra work.

### What your website visitors experience

Visitors see your aerial map with color-coded lots, a legend, and an **All Lots / Available Only** switch. Hovering or tapping a lot shows its number, size, price, and status. Tapping an **available** lot opens a short inquiry form (*"Inquire About Lot …"*) pre-addressed to that lot — name, email, optional phone, and a pre-written message they can edit.

### Where those inquiries go

Every website inquiry lands in your platform as a **Lead** with the lot attached, a follow-up task due the next day, and an activity note recording what the buyer asked about. Work them from **Leads**: open the lead, contact the buyer, log calls and visits, and move it along the pipeline from first contact to application. Possible duplicates are flagged automatically when the same email, phone, or name-and-lot appears twice.

---

## Part 4 — Automated Receipt Ingestion & Daily Briefs

### Forwarding payment receipts

Each development has a **dedicated payment inbox address** (ask your administrator for yours). Whenever a buyer sends a bank transfer screenshot or receipt photo:

1. Forward the email — attachments included — to that inbox address.
2. The platform reads the image, pulls out the **amount, reference number, payment method, and date**, and files the proof under the matching buyer automatically (matched by sender email).
3. The buyer immediately receives a *"Payment Proof Received"* confirmation email with the reference number.

Nothing arrives silently: unmatched senders are parked under a reconciliation queue with a follow-up lead, so staff always know what needs attention.

### Reviewing staged payments

Machine-read payments never touch your official books unsupervised. They arrive with the status **Needs Review**:

1. Open **Payments** and look for Needs Review entries — each shows the extracted amount, reference, confidence score, and the original proof image.
2. Compare the extraction against the image. Correct anything, link the right contract if one was not found automatically, then approve it to **Posted**.
3. Only Posted payments count toward balances, statements, and reports. Voided or corrected payments stay visible in history — records are never deleted.

### Reading the morning brief

Generate each day's brief from **Daily Briefs → Generate Morning Brief** (or a custom date range). The brief email and screen share the same structure:

* **Metric cards** — new applications and leads, payments logged, new contracts, open action items, resolved items, and outstanding balance.
* **Executive summary** — the day in plain language.
* **Today's priorities** — open items that need a decision, or a green all-clear when nothing does.
* **Activity breakdown and collections** — what moved yesterday and what money is still out.

To email it, open any brief and press **Email Brief**, enter the recipient, and send. The message arrives as a formatted operations email with a button back into the platform — handy for partners and managers who do not log in daily.

---

*Questions your administrator can answer: your platform address, your login level, your development's payment inbox address, and who approves staged payments.*
