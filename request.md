Project Development Specification: Personal & Shared Household Finance Management Application
1. Project Overview

Build a modern, secure, and scalable household finance management application that integrates KakaoBank transaction history, automatically analyzes household spending patterns, and supports both personal and shared household ledgers.

The application should transform bank transaction statements into structured financial data and provide meaningful insights into household income, expenses, savings, and spending behavior.

The system must support password-protected Excel imports, secure password storage, monthly transaction updates, Kakao Login, shared household management, and automated notifications.

Use the provided Excel reference files as the primary source of truth for transaction structures and existing expense analysis logic.

Reference Files

1. KakaoBank Transaction Statement

reference/카카오뱅크_거래내역_N7238749820_2026012520290507.xlsx

Use this file to understand the latest KakaoBank Excel transaction format and implement the import engine.

2. Existing Household Expense Analysis

reference/공용 가계부 (1).xlsx

Use this file to understand existing expense categories, analysis formulas, spending factors, and historical financial management logic.

Do not simply create a generic expense tracking application. Preserve and improve the existing analysis methodology.

2. Core Features
2.1. KakaoBank Excel Import System

Implement a robust Excel import system specifically designed for KakaoBank transaction statements.

Requirements:

Support .xlsx file uploads.
Analyze the actual structure of the provided KakaoBank Excel reference file.
Automatically recognize transaction columns and their data types.
Extract the following information where available:
Transaction date and time
Transaction description
Deposit amount
Withdrawal amount
Transaction balance
Counterparty information
Transaction classification
Automatically distinguish between income and expenses.
Convert imported records into a standardized internal transaction format.
Validate transaction data before importing.
Provide an import preview before final confirmation.
Detect and prevent duplicate transactions.
Allow users to edit transaction descriptions and categories.
Maintain an import history with upload dates and processing results.
Provide clear error messages when a file cannot be processed.

Design the import engine using a modular architecture so that additional Korean banks and Excel formats can be supported in the future.

2.2. Password-Protected Excel Support

KakaoBank Excel statements may be password-protected. The application must support password-protected Excel files and provide a convenient password management system.

First-Time Import Workflow:

The user uploads a password-protected Excel file.
The application detects that the file requires a password.
Display a password input dialog.
Ask whether the user wants to save the password for future imports.
If the user agrees, securely save the password.
Decrypt the Excel file on the server.
Process and import transactions normally.

Subsequent Import Workflow:

The user uploads another KakaoBank Excel statement.
The system checks whether a saved password exists for the relevant account and file format.
Automatically retrieve the saved password from secure server-side storage.
Attempt to decrypt the uploaded file without asking the user to enter the password again.
Continue transaction processing automatically.

Password Management Requirements:

Allow users to save passwords for future imports.
Password saving must be optional.
Allow users to change, replace, or delete saved passwords.
If decryption fails, request the password again.
If the password has changed, allow the user to update the stored credential.
Associate saved passwords with the appropriate user or household account.
Do not expose passwords to other household members by default.

Security Requirements:

Never store passwords in plain text.
Use strong authenticated encryption such as AES-256-GCM.
Store encryption keys separately from the application database.
Use a secure server-side encryption key management mechanism.
Never store passwords in browser local storage, session storage, application logs, or API responses.
Restrict password access to the server-side Excel processing service.
Ensure that unrelated users and households cannot access each other's saved credentials.
Support secure credential deletion.

The password management system should make future monthly Excel imports as seamless as possible while maintaining strong security.

2.3. Expense Factor Analysis Engine

Implement an advanced household spending analysis system based on the existing reference Excel file.

Reference:

reference/공용 가계부 (1).xlsx

Before implementation, inspect the workbook thoroughly, including:

Sheet structures
Column definitions
Existing expense categories
Formulas
Historical transaction data
Expense classification rules
Existing spending factor analysis logic

Preserve the useful existing analysis logic and convert it into a maintainable application-level analysis engine.

Core Analysis Features:

Automatically categorize transactions.
Identify major household expense categories.
Calculate monthly income and expenses.
Calculate net savings.
Analyze quarterly and yearly spending trends.
Identify recurring expenses and subscriptions.
Detect unusual spending increases.
Compare spending between different months.
Identify major contributors to increased household expenses.
Analyze spending behavior over time.
Allow manual category corrections.
Learn from user-corrected classifications where appropriate.

Dashboard Analytics:

Display the following information:

Total monthly income
Total monthly expenses
Monthly net savings
Savings rate
Expense breakdown by category
Monthly spending trends
Top spending merchants
Recurring expenses
Month-over-month comparisons
Year-over-year comparisons
Major expense factors

AI-Powered Financial Insights:

Provide natural-language explanations of spending patterns.

Example:

"Your dining expenses increased by 23% compared to last month. The primary contributors were four additional weekend dining transactions."

Additional examples:

Identify categories with unusually high spending.
Explain why total expenses increased.
Identify opportunities to reduce unnecessary spending.
Detect recurring payments that may no longer be needed.
Highlight significant changes in household financial behavior.

All financial insights must be based on actual imported transaction data. Never generate fabricated financial statistics.

2.4. Monthly KakaoBank Transaction Update System

Create a reliable monthly transaction update workflow.

The preferred approach is to retrieve KakaoBank transaction statements once a month.

API Integration Investigation:

Investigate whether an official KakaoBank API or authorized integration is available for transaction history retrieval.
Do not assume a public transaction API exists.
Do not implement unauthorized account access, credential scraping, or unsupported banking automation.

Manual Server Upload Fallback:

If an official API is unavailable, implement an administrator-only Excel upload interface.

Requirements:

Administrators can upload monthly transaction statements.
Automatically detect the Excel format.
Retrieve the saved Excel password when available.
Decrypt and parse the file.
Validate new transaction records.
Detect duplicates against existing records.
Import only new transactions.
Update financial analysis after successful imports.
Record upload history and processing status.
Display the most recent successful synchronization date.
Provide detailed error logs for failed imports.

Synchronization Status:

Display:

Last successful import date
Latest imported transaction date
Number of newly imported transactions
Number of duplicate transactions skipped
Import processing status

Design the system so that an authorized API integration can be added later without changing the entire architecture.

2.5. Notification System

Implement an application-wide notification system.

Notification Types:

New transaction data imported
Monthly financial analysis completed
Significant spending increases detected
Unusual transaction patterns identified
Shared household invitations received
Shared household members added or removed
Important application updates

Requirements:

In-app notifications
Read and unread status
Notification history
Notification timestamps
User-specific notification preferences
Optional push notifications
Optional email notifications

Ensure that notifications are delivered only to the appropriate users and household members.

2.6. Kakao Login and Authentication

Implement authentication using Kakao Login through the official Kakao OAuth integration.

Requirements:

Kakao account login
New user registration
Secure authentication sessions
User profile management
Account linking
Logout functionality
Secure token management
Authentication error handling

Use official Kakao developer documentation and supported OAuth flows.

Do not expose Kakao access tokens or sensitive authentication credentials to unauthorized clients.

2.7. Personal and Shared Household Accounts

The application must support both individual and shared household ledgers.

Use a separate Household entity to manage financial data independently of individual user accounts.

Personal Household:

Each user can create and manage a private household ledger.
Personal transactions remain private.
Users can independently manage their categories and financial analysis.

Shared Household:

Users can create shared household accounts.
Household owners can invite other users through Kakao-based invitation links or an appropriate Kakao sharing flow.
Invited users can accept or decline invitations.
Multiple members can access the same shared ledger.
Transaction changes should be synchronized across authorized members.
Shared household financial dashboards should reflect the same underlying transaction data.

Member Roles:

Owner
Full household management permissions.
Invite and remove members.
Manage household settings.
Manage financial data.
Manage saved Excel credentials.
Administrator
Manage members and household settings.
Manage transactions and imports.
Manage household financial data.
Member
View shared transactions.
Add and edit transactions according to assigned permissions.
View household financial analysis.

Security and Data Isolation:

Personal and shared household data must remain logically separated.
Users must only access households they belong to.
Shared household credentials must not automatically become visible to all members.
Restrict sensitive Excel password management to authorized roles.
Implement server-side authorization checks for every sensitive operation.
Prevent cross-household data access.
2.8. Transaction Management

Provide a dedicated transaction management interface.

Requirements:

View all transactions.
Search transactions by keyword.
Filter by date range.
Filter by income or expense.
Filter by category.
Filter by household.
Edit transaction descriptions.
Change transaction categories.
Add manual transactions.
Delete transactions with appropriate confirmation.
View transaction import sources.
Track transaction modification history.

Ensure that manually edited categories are not overwritten by subsequent imports unless explicitly requested.

3. Application Structure and Navigation

Organize the application into the following main sections.

3.1. Dashboard
Monthly financial overview
Total income and expenses
Net savings
Savings rate
Expense category charts
Monthly spending trends
AI-generated financial insights
Recent transactions
Latest synchronization status
3.2. Transaction History
Complete transaction list
Search and filtering
Transaction details
Manual transaction management
Excel import
Import history
3.3. Expense Analysis
Category-based analysis
Historical spending analysis
Expense factor analysis
Monthly comparisons
Quarterly and yearly reports
Recurring expense detection
Unusual spending alerts
AI financial insights
3.4. Household Management
Personal household ledger
Shared household ledger
Household switching
Member invitations
Member management
Role and permission settings
Shared household settings
3.5. Data Import Management
KakaoBank Excel upload
Password management
Import preview
Import history
Monthly synchronization status
Administrator upload interface
Import error logs
3.6. Notifications
Notification list
Read/unread status
Invitation notifications
Import notifications
Financial analysis notifications
System announcements
3.7. Settings
Kakao account settings
User profile
Household settings
Excel password management
Notification preferences
Security settings
4. Recommended Database Architecture

Design a relational database with a clear separation between user accounts, households, financial transactions, and sensitive credentials.

Suggested entities:

Users

id
kakao_user_id
name
profile_image
created_at
updated_at

Households

id
name
household_type (personal/shared)
owner_id
created_at
updated_at

HouseholdMembers

id
household_id
user_id
role
joined_at

Transactions

id
household_id
transaction_date
description
deposit_amount
withdrawal_amount
balance
category_id
transaction_type
source
external_transaction_key
created_at
updated_at

Categories

id
household_id
name
category_type
parent_category_id
created_at

ImportHistory

id
household_id
uploaded_by
file_name
import_date
transaction_count
duplicate_count
import_status
error_details

SavedCredentials

id
household_id
credential_owner_id
credential_type
encrypted_password
encryption_key_version
created_at
updated_at

HouseholdInvitations

id
household_id
inviter_id
invitee_id
invitation_token_hash
status
expires_at
created_at

Notifications

id
user_id
household_id
notification_type
title
message
is_read
created_at

TransactionAuditLogs

id
transaction_id
modified_by
action
previous_values
new_values
created_at

This schema is a starting point. Refine it after inspecting the actual Excel reference files and defining the final application architecture.

Implement appropriate foreign keys, indexes, constraints, and unique identifiers.

Use database transactions for importing and updating financial records.

5. Technical Architecture Requirements

Build a modular and maintainable application.

Architecture Requirements:

Frontend and backend should have clear responsibilities.
Use a relational database.
Implement secure authentication and authorization.
Separate Excel parsing from financial analysis logic.
Separate transaction classification from transaction storage.
Implement server-side Excel decryption.
Store sensitive credentials using authenticated encryption.
Implement import deduplication.
Maintain audit logs.
Use background processing for large Excel imports and financial analysis tasks when necessary.
Provide clear API boundaries between modules.
Design for future integration with additional banks.

Do not hardcode bank-specific parsing logic throughout the application.

Use a standardized internal transaction model and bank-specific import adapters.

6. UI/UX Design Requirements

Create a modern, clean, and intuitive financial management interface.

Design Direction:

Professional personal finance application.
Minimal and uncluttered layout.
Clear financial data visualization.
Consistent typography and spacing.
Intuitive navigation.
Responsive desktop and mobile layouts.
Clear distinction between income and expenses.
Easy switching between personal and shared households.

Dashboard Visualization:

Use appropriate charts and visual components:

Donut charts for expense categories.
Bar charts for monthly income and expenses.
Line charts for spending trends.
Comparison charts for month-over-month analysis.
Summary cards for key financial metrics.

The interface should prioritize readability and practical usability rather than excessive decoration.

7. Security and Privacy Requirements

Financial information is sensitive. Security must be considered throughout the application.

Requirements:

Secure Kakao OAuth authentication.
Server-side authorization.
Household-level data isolation.
Encryption of sensitive credentials.
Secure password management.
Protection against unauthorized data access.
Input validation and file upload validation.
Secure handling of Excel files.
Safe temporary file management.
Protection against malicious uploaded files.
Audit logs for sensitive financial operations.
Secure invitation token handling.
Appropriate session expiration and revocation.

Never expose financial information, saved Excel passwords, or authentication tokens to unauthorized users.

8. Development Roadmap

Implement the project incrementally in the following order.

Phase 1: Project Foundation
Inspect both Excel reference files.
Analyze existing transaction structures.
Analyze existing expense categories and formulas.
Design the system architecture.
Define the database schema.
Implement Kakao Login.
Implement users and household management.
Implement personal/shared household separation.
Phase 2: Excel Import and Password Management
Implement KakaoBank Excel parsing.
Implement password-protected Excel support.
Build the password input interface.
Implement optional secure password storage.
Implement automatic decryption for subsequent uploads.
Implement import validation.
Implement duplicate detection.
Build import history and error handling.
Phase 3: Transaction and Expense Analysis
Implement transaction management.
Reproduce existing expense classification logic.
Implement automatic categorization.
Implement monthly financial calculations.
Implement historical expense analysis.
Build the financial dashboard.
Implement AI-powered spending insights.
Phase 4: Monthly Updates and Notifications
Investigate official KakaoBank integration options.
Build the administrator Excel upload interface.
Implement monthly synchronization workflows.
Implement import status tracking.
Implement notifications.
Implement spending alerts.
Phase 5: Shared Household Features
Implement household invitations.
Implement member acceptance workflows.
Implement role-based permissions.
Implement shared transaction management.
Implement synchronized household dashboards.
Implement household-level credential permissions.
Phase 6: Testing and Optimization
Test Excel imports using the actual reference files.
Test password-protected Excel imports.
Test automatic password retrieval.
Test duplicate detection.
Test financial calculation accuracy.
Test personal/shared data isolation.
Test Kakao authentication.
Test invitation and permission workflows.
Optimize database queries.
Improve mobile responsiveness.
Perform security testing.
9. Important Development Instructions

Before writing application code, follow these instructions carefully.

Inspect both provided Excel reference files in detail.
Identify all sheets, columns, formulas, and data relationships.
Determine the actual Excel password protection mechanism and verify that the selected server-side library supports it.
Preserve the existing expense analysis logic wherever possible.
Design the database based on the actual financial data structure.
Implement a standardized transaction model.
Do not replace real Excel parsing with mock data.
Do not fabricate financial insights or statistics.
Do not assume KakaoBank provides a public transaction API.
Implement a fully functional manual upload workflow as the initial data update mechanism.
Never store Excel passwords in plain text.
Do not allow shared household members to access sensitive credentials without authorization.
Implement features incrementally and test each phase before moving forward.
Maintain clear documentation of the architecture, database schema, APIs, and import logic.
If an implementation detail is uncertain, investigate it before making architectural assumptions.

If the reference files are not accessible in the development environment, request that they be provided rather than guessing their structure.

10. Final Product Goal

Deliver a production-ready personal and shared household finance management application.

The final product should allow users to:

Log in using Kakao accounts.
Upload KakaoBank transaction statements.
Enter an Excel password once and securely save it for future imports.
Automatically decrypt and process subsequent monthly Excel statements.
Manage personal and shared household ledgers.
Invite family members or other users through Kakao-based invitations.
Automatically categorize income and expenses.
Analyze historical spending patterns using the existing Excel reference logic.
Understand the major factors driving household expenses.
View meaningful financial dashboards and AI-generated insights.
Receive notifications about new financial data and important changes.

The ultimate objective is to build a reliable household financial management platform that replaces manual spreadsheet-based expense tracking with an automated, intelligent, and collaborative financial management experience.

Development principle: Build a fully working, data-driven application based on the actual Excel reference files. Prioritize financial data accuracy, security, and a reliable import workflow over superficial UI features.