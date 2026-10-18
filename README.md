# Niall's Toolkit

Niall's Toolkit runs as a **Chrome extension**, a **Windows app** and an **iPhone app**, all with the same data (version 2.0). **To set up the apps and sync, follow [SETUP.md](SETUP.md).**

It has these tools:

- **Storefront tracker:** tracks competitor Amazon storefronts and shows the new products they list. It uses your own Keepa API key.
- **Retailer & wholesaler outreach:** turns storefront-tracker leads into suppliers. Brands and products are ranked by how many tracked storefronts list them, demand, price stability, and profit and ROI at the supplier's price. It also includes a supplier pipeline, email templates and follow-up reminders.
- **eBay profit tracker:** import your eBay reports, set costs per product and see your profit.
- **FBA Returns tracker:** follows every returned FBA unit from Amazon booking the return to resale on eBay or as Amazon Used, with the full P&L per unit.
- **FBA Admin:** imports your bank statement, SellerToolkit exports and Amazon reports, categorises every bank line (fix any that are wrong), shows your key numbers on a dashboard, works out actual net profit per product after expenses and returns, checks every Amazon payout reached the bank, keeps your invoices and receipts, tracks subscriptions and the director's loan, builds a year-end pack for your accountant, and mirrors it all to a Google Sheet.

Click the toolbar icon to open the toolkit in Chrome's **side panel**. On a narrow laptop window (or zoomed in) the menu shrinks to icons so it always stays on screen; hover an icon for its name. Use **Tab ↗** in the panel, or right-click the icon → *Open Niall's Toolkit in a full tab*, for the wide dashboard.

There's no server and no subscription. Each device keeps its own copy of your data, and **Devices & sync** keeps them in step through a folder in your own Google Drive.

## Devices & sync

- **Devices & sync** (in the menu) connects Google and turns sync on, then lists your devices.
- **Add another device** shows a QR code and setup code, so a phone is set up without typing anything.
- Sync runs when the app opens, about 20 seconds after a change, every 5 minutes while it's open, and as you switch away. The extension also syncs every 15 minutes in the background.
- The top bar shows the sync status. Click it for details.
- How changes merge: for each record the newer change wins, deletions reach every device, and settings merge field by field.
- Receipt files travel once each.
- API keys stay on each device unless you tick **Sync my API keys too**.

## Retailer & wholesaler outreach

- **Overview:** follow-ups due, the pipeline (To contact → Emailed → Replied → Account open → Ordering) and the brands to approach first.
- **Brands & products:** every brand and product your tracked storefronts list, scored 0–100:
  - 35% how many storefronts list it
  - 25% demand (Keepa monthly sales or sales rank)
  - 15% price stability (90-day low/high and 30-day vs 90-day average)
  - 25% profit, from ROI at the supplier's price, or the room left after Amazon fees
  - minus 15 if Amazon sells on the listing

  **Max buy** is the most you can pay for your target ROI. *Load details* fetches Keepa details for products that don't have them yet (about 1 token each).
- **Leads:** brands or ASINs you want a supplier for. Add them from the ranking, or with **＋ Lead** in the New products feed.
- **Suppliers:**
  - company, contact, email, phone, website, account number, minimum order and notes
  - the leads each supplier stocks, with their price (per product, for brands)
  - an activity log of emails, calls, notes and stage changes
  - import or export as CSV
- **Email:** pick a template and the email fills itself in (contact, brands, products, your details). **Open in email app** logs it, moves the supplier to Emailed and sets the follow-up date.
- Follow-ups due show on the Outreach overview, the menu badge, and the FBA Admin dashboard's Last week card.
- Outreach has its own **Outreach** and **Outreach Brands** tabs in the Google Sheet, and is included in backups.

## Cash flow: daily budget

Cash flow → **Daily budget** works out:

- **Safe to spend today:**
  1. start from today's balance
  2. add the Amazon payouts predicted from your sales, and eBay payouts
  3. take off every bill, Klarna instalment, subscription and tax payment due
  4. take off your buffer
  5. spread the rest over the next 14, 28 or 42 days, so the balance never dips under the buffer on any day
- **Weekly stock allowance:** that daily amount × 7, less your usual other spending.
- **Next Amazon payout** and **Waiting at Amazon**: due in the next payout, plus held back for later ones.

How payouts are predicted:

- Net proceeds per day (sale − Amazon fees − VAT on fees, refunds on the day they happen) are grouped into Amazon's settlement cycles.
- Days not imported yet use your usual takings for that weekday.
- The hold (delivery + reserve), the settlement rhythm and the days to your bank are **learned** by testing which fits your past payouts best.

Also on the page:

- **Predicted vs actual payouts** shows how close the forecast has been, both against past payouts and against each prediction as the real payout arrives.
- **Spending against target** shows each day's target next to what left the bank, not counting planned bills.
- **What if…** tries lower or higher sales, late payouts or a big one-off purchase.

**Safe to spend today** is also on the FBA Admin dashboard, in its tile and in the Last week card.

**Log a spend** (on the Cash flow page, or the Windows app's taskbar shortcut): note a purchase as you make it.

- It counts against today's budget straight away.
- When the bank statement is imported, it matches itself to the payment (same amount within 2%, up to 6 days later) and stops counting separately.

## SellerFuse (v2.1)

FBA Admin → Settings & Google Sheets → **Sales, fees, COGS and expenses come from**: SellerToolkit, or SellerFuse from a cut-over date.

- **Import:** SellerFuse orders (Amazon and eBay), expenses and cost-of-goods exports go in on the Import tab. A file with "SellerFuse" in its name is recognised automatically. The column check lets you match any column before importing.
- **Cut-over:** SellerToolkit counts before the cut-over date and SellerFuse from it. This applies separately to orders, expenses and purchases, so nothing is counted twice. Leave the date blank to use your first SellerFuse order.
- **What it feeds:** the P&L, Sold products, Stock value, the VAT gauge, year end, the daily budget and the Returns tracker's unit costs. SellerFuse's eBay orders replace the eBay tracker in the Amazon + eBay figures from the cut-over date.
- **Reports guide:** shows the SellerFuse downloads instead.
- **Column names** are a first guess until they're matched against real SellerFuse exports.

## Supplier price lists (v2.2)

Sourcing → **Price lists**. Drop a wholesaler's price list (CSV or Excel).

- **Reading the list:** columns are found by name, even below a banner row. You set whether prices are per unit or per case, and ex or inc VAT.
- **Barcodes:** barcodes Excel has turned into "5.01E+12" are flagged.
- **Find on Amazon:** looks up each barcode through Keepa, about 1 token each. The cost is shown first, and a barcode already looked up is free on any device.
- **Lines without a barcode:** search by name, about 10 tokens each. Check name matches, and use ✕ to undo a wrong one.
- **Results:** each line shows profit, ROI and max buy after fees, prep and shipping, plus sales, price stability, competition and a score.
- **Filters:** min ROI, min profit, and hide Amazon-sold.
- **Ticked to Outreach:** adds the products as leads linked to that supplier at their price.

## Lead sheet (v2.2)

Sourcing → **Lead sheet** reads your Google Sheet ("Buy Sheet") with your Google sign-in. It never writes to it and uses no Keepa tokens. It shows:

- the best ones to buy (score: ROI, profit per unit, sales per month, and a nudge when the price is due to go up within 2 weeks)
- most profitable, highest ROI and best sellers
- prices going up soon
- stats by store and by month
- every lead, sortable and searchable

ROI is worked out as profit ÷ cost, because the sheet's ROI column mixes formats. The last copy stays on each device for offline use.

## Weekly backups to Google Drive (v2.2)

Backup & restore → **Weekly backups to Google Drive**.

- **What:** a dated copy of everything (receipts included, API keys never), once a week.
- **Where:** **Niall's Toolkit Backups** in your Drive, kept forever.
- **Who makes it:** whichever device is open first.
- **Restoring:** **Show backups → Restore** merges a backup in, putting back anything missing without deleting anything.

## Start Up Loan (v2.2)

Personal → **Start Up Loan**, kept out of the business figures.

- **Each loan part:** amount, APR, term, drawdown and first payment dates. The monthly payment is worked out, or you enter the exact one from your statement.
- **What it shows:** what's left on each part and in total, monthly repayments (and when they rise), interest paid and to come, and the debt-free date.
- **Calendar and chart:** a payment calendar, and a chart of the total owed.
- **Lump sums:** record each one (it previews the interest saved). Choose whether it finishes the loan sooner or lowers the monthly payment.

## Returns: refunds, outbound fee, loss report (v2.2)

- **Refunds:** refunded items in your SellerToolkit / SellerFuse orders become Returns tracker units automatically. Amazon's returns report later fills in the LPN and condition, never duplicating. Items your orders say went back to stock are marked auto-relisted.
- **Outbound fee:** each returned unit carries the **outbound FBA fee** Amazon keeps on a return.
- **Loss report:** return rate and loss per product (flagging ones to review), by month, where the money went, and why items came back.

## Phone extras (v2.1)

- **Paste link** (Storefront tracker): copy an Amazon link in the Amazon app or Safari, then tap Paste link.
  - A storefront or seller page is tracked.
  - A product page becomes an outreach lead.
  - On Windows and Android, you can also share a link straight to the installed app.
- **Take a photo of a receipt** (FBA Admin → Invoices): opens the camera. Photos are shrunk to a few hundred KB and dated today, ready to link to the bank line.

## Install the extension on a new computer (about 2 minutes)

Updating from 1.x? Follow [SETUP.md](SETUP.md) Part 4 instead: copy the new files over your existing extension folder so your data stays.

1. Unzip `nialls-toolkit.zip` somewhere permanent, such as `Documents/Nialls Toolkit`. Chrome loads it from that folder, so don't delete it afterwards.
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right switch).
4. Click **Load unpacked** and select the `nialls-toolkit` folder (the one that contains `manifest.json`).
5. Pin the extension from the puzzle-piece menu, then click its icon to open the side panel.

It starts in **demo mode**, with made-up data and no tokens used. Click **Load demo storefronts** to see how it works.

### Going live with Keepa

1. Get an API key at keepa.com → *Data* → *API*. It needs a paid API plan; the smallest plan (about 20 tokens/min) is plenty to start with.
2. Go to **Settings**, paste the key, click **Test key**, untick **Demo mode** and click **Save**. You'll be offered the option to clear the demo data.

To update to a new version, replace the folder contents and click ↻ on the extension card in `chrome://extensions`. Your data is kept.

## Storefront tracker

### Adding storefronts

- **Manually:** paste a seller ID or storefront link (`…/s?me=…` or `…/sp?seller=…`) into the box at the top and click **Track storefront**.
- **From Amazon:** open any storefront or seller page on Amazon UK/DE/FR/IT/ES and click **＋ Track seller in Niall's Toolkit** (bottom-right). You can also right-click a seller link.
- **Import CSV:** on the Storefronts tab, upload a CSV or Excel file of seller IDs and/or storefront links.
  - Optional columns: `Name`, `Marketplace` (UK/DE/FR/IT/ES) and `Note`.
  - Storefronts you already track are skipped.
  - You can import straight away or leave them for the next refresh.
- **Export CSV:** downloads one row per storefront. The columns are name, seller ID, marketplace, links, products listed, new and dropped in the last 7 days, rating, last refresh and note. The file can be imported back in, which is handy for moving your list to another computer.

### Daily routine

Click **Refresh all** once a day. Each storefront costs 10 Keepa tokens. The refresh compares each storefront with the previous one and splits products into:

- **New:** listed since your last refresh. Price, BSR, monthly sales, offer count and whether Amazon is on the listing are loaded automatically, at about 1 token per product.
- **🔥 N sellers:** the product is also listed by other storefronts you track. These are usually the strongest leads.
- **Dropped:** the product disappeared from a storefront (sold out or delisted). To see these, tick *Show dropped instead*.

In the **New products** feed you can:

- filter by period, storefront, price or BSR, or "in 2+ storefronts"
- mark products as reviewed
- export the feed to CSV

On the **Storefronts** tab you can tick 2 or more storefronts and click **Shared products** to see what they all sell.

New products show in the **New products** feed, with a count on the menu, on every device. (The Discord option was removed in 2.2.)

Note: Keepa collects storefront data daily and includes products listed within the last 7 days. So "new" means new since your last refresh, and "dropped" can lag by up to a week.

## eBay profit tracker

1. **Import** your eBay **Transaction report** (Seller Hub → Payments → Reports → Transaction report → CSV). It includes real final value fees, refunds, postage labels and ad fees.
   - The **Orders report** also works, but fees are estimated using the % in Settings.
   - Re-importing overlapping dates is safe, because duplicates are skipped. Each import can be undone.
2. **Products & COGS:** set the **COGS per unit** and a **Prep & postage per unit** figure (prep-centre handling, storage, postage to the buyer). Both apply to every sale of that product. You can also bulk-upload a CSV with `SKU` and `COGS` columns.
3. **Overview:** shows sales, fees, refunds, net payout, COGS and profit for any date range, broken down by month.

## FBA Returns tracker

One record per physical returned item. Each unit carries its cost basis (COGS + original inbound), every cost of getting it back and resold (return fee, removal, prep, storage, postage, re-inbound), any Amazon reimbursement, and its resale.

1. **Costs first:** Import → drop your SellerToolkit **Cost of Goods V4 Detailed** export. It averages each SKU's purchase lots into a cost per unit. Your own CSV with `SKU` and `COGS` works too, and you can edit costs on the **Costs** tab.
2. **Returns:** import the **FBA customer returns** report (Reports → Fulfilment → Customer returns). A quantity-2 line becomes two units (LPN#1, LPN#2). Sellable units Amazon put back into stock are marked *Auto-relisted*.
3. **Then, as they happen:** removal order detail → removal shipment detail → reimbursements → prep centre invoices → eBay / Amazon Used sales. Each one moves units on and adds its costs.
4. Open any unit to edit it, add a sale, or move it to its next stage. Only legal moves are offered.
5. Anything a report mentions that can't be matched to a unit goes to **Unmatched**, with the reason.

Re-importing any report is safe: each report line is applied to a unit at most once. Every file you drop shows its detected type and column mapping before you import, so you can correct either. *Units → CSV* and *Settings → Full ledger CSV* give you a spreadsheet copy. Google Sheets sync arrives with FBA Admin.

## FBA Admin

0. **Reports guide** (FBA Admin → Reports guide) shows, for each report, where to find it, what date range to download, when you last imported it and whether it's due. A monthly tick-list and the number on the FBA Admin menu item remind you what's left. Tick *Done / nothing to download this month* when there's nothing to fetch, for example no returns.
1. **Import** (FBA Admin → Import), as often as you like. Overlapping dates are safe.
   - **Bank statement CSV.** In Revolut Business choose *Statement*, then *CSV* (PDF statements can't be read). Other banks' CSVs work too, and you can check the column mapping before importing.
   - **SellerToolkit Orders – Detailed:** sales, Amazon fees, COGS and refunds per order.
   - **SellerToolkit Expenses:** used for overheads in months your bank statement doesn't cover.
   - **SellerToolkit Cost of Goods:** your stock purchases. It also sets the Returns tracker's SKU costs.
   - **Amazon Inventory Ledger** (Reports → Fulfilment → Inventory Ledger → Summary view, by location): what Amazon received, holds now (sellable / unfulfillable) and removed.
   - **Amazon All Listings report:** listing status and price per SKU.
   - **Amazon Sales Dashboard** download: Amazon's own monthly ordered sales, shown next to SellerToolkit's as a cross-check.
   - **Amazon Settlement report (Flat File V2)**, one per payout, or one **Date Range report** (Transaction) for the month: storage, subscription, removal, placement and advertising fees, reimbursements, and every payout. The Date Range report also feeds the Returns tracker.
   - **Returns, removal and reimbursement reports** dropped here go straight to the Returns tracker.
2. **Transactions.** Every bank line gets a category. Change any that are wrong from the dropdown, or tick several and set them together. You'll be offered *Make rule* so that payee is always categorised that way. Categories you set by hand are never changed by rules or re-imports.
3. **Dashboard.** Pick a period and *Amazon only* or *Amazon + eBay* to see P&L (revenue, fees + VAT, COGS, SellerToolkit profit, Amazon account fees, reimbursements, overheads, returns loss, net profit, margin), the director's loan, cash in and out, Amazon payouts, return rate, stock at cost, subscriptions per year, ad spend %, the VAT threshold gauge, and a *Needs attention* list.
4. **Stock.** Aged stock first: units at or near Amazon's aged inventory surcharge (from day 241), with the date it starts and the monthly cost, so you can lower the price or remove them in time. Import the **FBA Inventory** report (Inventory → FBA Inventory → Download) for Amazon's own ages; otherwise they're estimated from the inventory ledger. Then per SKU: bought, received, sold, returned, removed, sellable and unfulfillable at Amazon now, value at cost, and listing status. It flags unfulfillable units to remove, sellable stock on an inactive listing, purchases not yet received, and units Amazon lost or damaged.
5. **Sold products.** Actual net per product = SellerToolkit profit + Returns tracker loss − a share of overheads (by revenue or by units).
6. **Expenses** (FBA Admin → Expenses). One place for every cost:
   - *Calendar*: your bank payments, plus everything expected, day by day. Expected payments tick off by themselves when the matching bank line is imported.
   - *Recurring*: anything regular (phone, insurance, software, Klarna instalments) or regular income, with how often and whether it comes from the business account or you personally. Confirmed subscriptions appear here too.
   - *Planned one-off*: a bill you know is coming (accountant, a big stock order).
   - *Added by hand*: costs paid with your own card or cash. They count as overheads and are added to your director's loan. Mileage goes here at HMRC's 45p a mile.
7. **Stock value.** Your stock at cost (everything bought, less what sold) and how it has moved: bought, sold and the stock value at the end of each month, quarter or financial year, with charts. Set a goal, such as £5,000 of stock by a date, to see how much to buy each month and whether the bank balance forecast can carry it.
8. **Cash flow.** Your bank balance over the next 30, 60 or 90 days: the latest bank balance, plus expected Amazon and eBay payouts (at the rate they've been arriving), your recurring and planned costs, subscriptions, stock buying at your usual weekly rate and corporation tax when it's due. It warns when the balance would drop under your buffer or below £0.
9. **Payouts & fees.** Every Amazon payout matched to its bank line (same amount, banked within a week), payouts missing from the bank, and the account-level fees and reimbursements SellerToolkit leaves out. These go into net profit.
10. **Invoices.** Drop PDFs or photos of receipts (or click the paperclip on a bank line). Each is renamed `date_Supplier_£amount_Type.pdf`, linked to its bank line or stock purchase, and kept in the extension, in Google Drive (*FBA Accounting › Invoices › year › month*), or both (Settings). *Missing receipts* lists costs over £10 with nothing attached. Files kept in the extension are in FBA Admin's backup.
11. **Subscriptions.** Repeating payments found in the bank. Confirm the real ones to see the monthly and yearly total, the next payment date, price rises and ones that seem to have stopped.
12. **Director's loan.** What the company owes you, now and for any year, with a balance chart and the full statement: bank lines categorised Director Loan, costs you paid personally, and entries you add on this tab for money put in or repaid outside the business account. Set the opening balance here (from your last accounts). It's included in FBA Admin's backup.
13. **Year end.** At the bottom, **Accountant pack** downloads one zip for a year or a quarter: a printable summary, the P&L, bank transactions (with the receipt for each), costs outside the bank, the director's loan, sold products, payouts, Amazon fees, stock, subscriptions and every saved invoice in month folders.
   The year end itself: Amazon-only and Amazon + eBay P&L, a corporation tax estimate, stock at cost, the director's loan account (enter its opening balance in Settings) and a checklist of what to fix before sending it to your accountant. *Print / Save as PDF* or CSV, and it's in the Google Sheet's Year End tab. Figures are estimates for management, not statutory accounts.
14. **Targets and Last week** (Settings & Google Sheets). Set a sales and net profit target per month to see progress and the daily pace needed on the dashboard. The **Last week** card at the top of the dashboard has last week's figures, the month's target, your budget and cash forecast, bills coming up and anything that needs doing.
15. **Google Sheets.** In *Settings & Google Sheets*, follow the one-time set-up (about 10 minutes), click *Connect Google*, then *Sync now*. The extension creates an **FBA Accounting** spreadsheet and keeps it updated after every import and edit. You can change categories in the sheet's Transactions tab, then click *Pull category changes*.

Not counted as overheads: stock purchases (costed through COGS), Amazon / eBay payouts (already in the sales figures), director's loan (including the Klarna payments) and transfers. Ad spend paid by card is an overhead; ads billed to your Amazon balance come from the settlement report. The financial year runs from 28 February (change it in Settings).

## Good to know

- **Back up your data.** Without sync it lives only on each device (removing the extension deletes its copy). Even with sync on, a backup file protects you from mistakes, because sync copies deletions too.
  - **Backup & restore** (in the menu) has *Export everything* / *Import everything from a file* for the whole toolkit in one go, plus Export and Import for each module on its own, with when you last exported each.
  - Every page also has a **Backup** button (top right) for that page's module.
  - Importing **merges**: it adds missing records, keeps the newer copy where both exist, and never deletes anything. You'll see what will change before anything is written.
  - API keys and tokens are left out unless you tick *Include API keys and tokens* (the file is then named `…_WITH-KEYS_…`; keep it private).
  - Invoice and receipt files kept in the extension are inside FBA Admin's backup.
  - Old v1.0 backups and backups from the standalone FBA Returns Tracker extension can be imported too.
  - Safe update routine: copy the new files over the same folder and click ↻ on `chrome://extensions` (your data stays). If you ever remove and re-add the extension, *Export everything* first and import the file afterwards.
- **Running out of tokens.** If Keepa runs out of tokens during a refresh, the extension waits for them to refill and carries on. You can cancel at any time, and anything already fetched is saved.
