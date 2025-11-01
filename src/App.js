/* global __app_id, __firebase_config, __initial_auth_token */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, query, orderBy, addDoc, onSnapshot, doc, setDoc, updateDoc, deleteDoc, getDocs, writeBatch, runTransaction } from 'firebase/firestore';
import AuthPage from './AuthPage';
// NOTE: We assume recharts components are available in the environment.
// Mocked Recharts components for preview
const Recharts = {
    PieChart: ({ children, width, height }) => <div style={{ width, height }} className="flex justify-center items-center mx-auto">
        <svg width={width} height={height} viewBox="0 0 300 200" className="max-w-full">
            {children}
        </svg>
    </div>,
    Pie: ({ data, dataKey, nameKey, cx, cy, innerRadius, outerRadius, fill }) => {
        if (!data || data.length === 0) return null;

        let startAngle = -90; // Start at the top

        return data.map((entry, index) => {
            const { value, fill: sliceFill } = entry;
            // Use the globally set totalValueForPie
            const percent = (value / totalValueForPie) * 100;
            const angle = (value / totalValueForPie) * 360;
            const endAngle = startAngle + angle;
            
            const path = getSlicePath(cx, cy, innerRadius, outerRadius, startAngle, endAngle);
            
            startAngle = endAngle;

            return (
                <path 
                    key={`slice-${index}`} 
                    d={path} 
                    fill={sliceFill || fill} 
                    stroke="#fff" 
                    strokeWidth="1"
                />
            );
        });
    },
    Cell: ({ fill }) => <span style={{ backgroundColor: fill }} className="inline-block w-3 h-3 rounded-full mr-2"></span>,
    Tooltip: () => <div className="hidden"></div>, // Tooltip not implemented in mock
    Legend: ({ payload }) => (
        <div className="flex flex-wrap justify-center mt-4 text-xs md:text-sm">
            {payload?.map((entry, index) => (
                <div key={`legend-${index}`} className="flex items-center mx-2 my-1">
                    <Recharts.Cell fill={entry.color} />
                    {entry.value}
                </div>
            ))}
        </div>
    )
};

// --- SVG HELPER ICONS ---
// This is the single-path "line graph" style icon
const TrendUpIcon = () => (
    <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="m 4.5 19.5 5.25 -5.25 3 3 5.25 -5.25 3.75 3.75 V 6.75 H 15" />
    </svg>
);

const TrendDownIcon = () => (
    <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
         <path strokeLinecap="round" strokeLinejoin="round" d="m 4.5 4.5 5.25 5.25 3 -3 5.25 5.25 3.75 -3.75 V 17.25 H 15" />
    </svg>
);


// --- PIE CHART SVG HELPERS ---
const toCartesian = (cx, cy, r, angle) => {
    const rad = (angle * Math.PI) / 180;
    return {
        x: cx + r * Math.cos(rad),
        y: cy + r * Math.sin(rad),
    };
};

const getSlicePath = (x, y, innerRadius, outerRadius, startAngle, endAngle) => {
    // Ensure angles are valid numbers
    if (isNaN(startAngle) || isNaN(endAngle)) {
        return '';
    }
    
    // Handle full circle
    if (endAngle - startAngle >= 360) {
        endAngle = startAngle + 359.99;
    }

    const startOuter = toCartesian(x, y, outerRadius, startAngle);
    const endOuter = toCartesian(x, y, outerRadius, endAngle);
    const startInner = toCartesian(x, y, innerRadius, startAngle);
    const endInner = toCartesian(x, y, innerRadius, endAngle);

    const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

    // M: Move to startOuter
    // A: Arc to endOuter
    // L: Line to endInner
    // A: Arc back to startInner
    // Z: Close path
    return `
        M ${startOuter.x} ${startOuter.y}
        A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuter.x} ${endOuter.y}
        L ${endInner.x} ${endInner.y}
        A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${startInner.x} ${startInner.y}
        Z
    `;
};

// Global total for Pie calculation
let totalValueForPie = 0;

// --- GLOBAL VARIABLES (SECURELY LOADED FROM .env.local) ---
const firebaseConfig = {
  apiKey: process.env.REACT_APP_API_KEY,
  authDomain: process.env.REACT_APP_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_PROJECT_ID,
  storageBucket: process.env.REACT_APP_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_APP_ID
};

// ADD THIS DEBUGGING LINE
console.log("My Firebase Config:", firebaseConfig);

const appId = firebaseConfig.appId;
const initialAuthToken = null;

// Currency definitions
// USD is the base currency for storage.
const BASE_CURRENCY = 'USD';
const CURRENCIES = {
    USD: { code: 'USD', symbol: '$', name: 'US Dollar', rate: 1 },
    INR: { code: 'INR', symbol: '₹', name: 'Indian Rupee', rate: 83.0 }, // Placeholder
    EUR: { code: 'EUR', symbol: '€', name: 'Euro', rate: 0.92 }, // Placeholder
    GBP: { code: 'GBP', symbol: '£', name: 'British Pound', rate: 0.79 }, // Placeholder
    JPY: { code: 'JPY', symbol: '¥', name: 'Japanese Yen', rate: 150.0 }, // Placeholder
    AUD: { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', rate: 1.5 }, // Placeholder
    CAD: { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar', rate: 1.35 }, // Placeholder
};

// Default Categories (used if user has not yet set custom categories)
const DEFAULT_INCOME_CATEGORIES = ['Salary', 'Freelance', 'Investment', 'Gift', 'Other Income'];
const DEFAULT_EXPENSE_CATEGORIES = ['Food', 'Travel', 'Bills', 'Groceries', 'Rent/Mortgage', 'Entertainment', 'Health', 'Other Expense'];

// Colors for the Pie Chart slices
const COLORS = ['#8884d8', '#82ca9d', '#ffc658', '#ff8042', '#0088FE', '#00C49F', '#FFBB28', '#FF8042'];

// Helper to format currency
// Converts a base USD amount to the selected display currency
const formatCurrency = (baseAmount, displayCode, rates) => {
    const rate = rates[displayCode] || 1;
    const convertedAmount = baseAmount * rate;
    
    const absAmount = Math.abs(convertedAmount); 
    return new Intl.NumberFormat('en-US', { 
        style: 'currency', 
        currency: displayCode, 
        minimumFractionDigits: 2 
    }).format(absAmount);
};

// Helper to CONVERT a displayed amount (like INR) back to the BASE (USD) for storage
const convertToGlobalBase = (displayedAmount, displayCode, rates) => {
    const rate = rates[displayCode] || 1;
    if (rate === 0) return displayedAmount; // Avoid division by zero
    return displayedAmount / rate;
};

// Helper to check if transaction timestamp is within the filter range
const isTransactionInPeriod = (timestamp, month, year) => {
    if (!month && !year) return true; // No filter applied

    const transactionDate = new Date(timestamp);
    const transactionMonth = transactionDate.getMonth() + 1; // 1-indexed
    const transactionYear = transactionDate.getFullYear();

    const monthMatch = !month || transactionMonth === parseInt(month, 10);
    const yearMatch = !year || transactionYear === parseInt(year, 10);

    return monthMatch && yearMatch;
};

// Helper function to get default date for modal
const getModalDefaultDate = (filterMonth, filterYear) => {
    const now = new Date();
    const currentMonth = (now.getMonth() + 1).toString();
    const currentYear = now.getFullYear().toString();

    let defaultDate;
    
    // Check if filter is set to the current month and year (or no filter)
    if (
        (filterMonth === currentMonth && filterYear === currentYear) ||
        (filterMonth === '' && filterYear === currentYear) ||
        (filterMonth === currentMonth && filterYear === '') ||
        (filterMonth === '' && filterYear === '')
    ) {
        // Use current date and time
        defaultDate = now;
    } else {
        // Use the 1st of the filtered month/year
        // We use parseInt to ensure correct date math
        const year = parseInt(filterYear || currentYear, 10);
        const month = parseInt(filterMonth || currentMonth, 10) - 1; // Date object month is 0-indexed
        defaultDate = new Date(year, month, 1, 12, 0, 0); // Default to 1st of month at 12:00 PM
    }

    // Format for datetime-local input: YYYY-MM-DDTHH:mm
    const yyyy = defaultDate.getFullYear();
    const mm = (defaultDate.getMonth() + 1).toString().padStart(2, '0');
    const dd = defaultDate.getDate().toString().padStart(2, '0');
    const hh = defaultDate.getHours().toString().padStart(2, '0');
    const min = defaultDate.getMinutes().toString().padStart(2, '0');

    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
};


// ---
// --- CONFIG MODAL SUB-COMPONENTS (Moved outside App to prevent focus loss)
// ---

// 1. Navigation View
const NavigationView = ({ theme, textHeading, handleNavAction, setView }) => (
    <div className="grid grid-cols-2 gap-4">
        <button
            onClick={() => handleNavAction('Goal')}
            className={`flex flex-col items-center justify-center p-6 rounded-lg shadow transition duration-150 ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600' : 'bg-indigo-50 hover:bg-indigo-100'}`}
        >
            <svg className="w-8 h-8 text-indigo-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19V6l-2 3M9 19h6M9 6h6m-3-3v16m-6-4h12m-6 0h.01"></path></svg>
            <span className={`font-semibold ${textHeading}`}>Set Budget Goal</span>
        </button>
        <button
            onClick={() => handleNavAction('Report')}
            className={`flex flex-col items-center justify-center p-6 rounded-lg shadow transition duration-150 ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600' : 'bg-blue-50 hover:bg-blue-100'}`}
        >
            <svg className="w-8 h-8 text-blue-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
            <span className={`font-semibold ${textHeading}`}>View Report</span>
        </button>
        <button
            onClick={() => setView('Categories')}
            className={`flex flex-col items-center justify-center p-6 rounded-lg shadow transition duration-150 ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600' : 'bg-green-50 hover:bg-green-100'}`}
        >
            <svg className="w-8 h-8 text-green-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 7h.01M7 3h2a2 2 0 012 2v6c0 1.1-.9 2-2 2H5a2 2 0 01-2-2V5c0-1.1.9-2 2-2h2zm2 10h.01M15 15h.01M15 11h.01M11 7h.01M11 3h2a2 2 0 012 2v2c0 1.1-.9 2-2 2h-2a2 2 0 01-2-2V5c0-1.1.9-2 2-2zm2 10h.01M19 19h.01M19 15h.01M15 15h2a2 2 0 002-2v-2c0-1.1-.9-2-2-2h-2a2 2 0 00-2 2v2a2 2 0 002 2z"></path></svg>
            <span className={`font-semibold ${textHeading}`}>Manage Categories</span>
        </button>
        <button
            onClick={() => setView('Recurring')}
            className={`flex flex-col items-center justify-center p-6 rounded-lg shadow transition duration-150 ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600' : 'bg-purple-50 hover:bg-purple-100'}`}
        >
            <svg className="w-8 h-8 text-purple-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 0020.423 18.571M18.356 6.429A8.001 8.001 0 005.581 15H4a2 2 0 01-2-2V9a2 2 0 012-2h10l-3 3"></path></svg>
            <span className={`font-semibold ${textHeading}`}>Recurring Templates</span>
        </button>
        <button
            onClick={() => setView('Theme')}
            className={`flex flex-col items-center justify-center p-6 rounded-lg shadow transition duration-150 ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600' : 'bg-yellow-50 hover:bg-yellow-100'}`}
        >
            <svg className="w-8 h-8 text-yellow-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path></svg>
            <span className={`font-semibold ${textHeading}`}>Theme & Preferences</span>
        </button>
        <button
            onClick={() => setView('Reset')}
            className={`flex flex-col items-center justify-center p-6 rounded-lg shadow transition duration-150 ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600' : 'bg-red-50 hover:bg-red-100'}`}
        >
            <svg className="w-8 h-8 text-red-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            <span className={`font-semibold ${textHeading}`}>Reset All Data</span>
        </button>
    </div>
);

// 2. Category View
const CategoryView = ({ 
    theme, textHeading, cardBg, border, inputBg, itemBg, subText, 
    db, userId, appId, categories, 
}) => {
    const [newCategoryType, setNewCategoryType] = useState('Expense');
    const [newCategoryName, setNewCategoryName] = useState('');

    const handleAddCategory = async (e) => {
        e.preventDefault();
        if (!db || !userId || newCategoryName.trim() === '') return;

        const categoryName = newCategoryName.trim();
        const categoryDocRef = doc(db, `/artifacts/${appId}/users/${userId}/settings/categories`);
        
        try {
            await runTransaction(db, async (transaction) => {
                const categorySnap = await transaction.get(categoryDocRef);
                const currentData = categorySnap.data() || { Income: DEFAULT_INCOME_CATEGORIES, Expense: DEFAULT_EXPENSE_CATEGORIES };
                
                const currentList = currentData[newCategoryType] || (newCategoryType === 'Income' ? DEFAULT_INCOME_CATEGORIES : DEFAULT_EXPENSE_CATEGORIES);

                if (currentList.includes(categoryName)) {
                    console.error("Category already exists.");
                    return; // Abort transaction
                }
                
                const updatedCategories = {
                    ...currentData,
                    [newCategoryType]: [...currentList, categoryName].sort(),
                };
                
                transaction.set(categoryDocRef, updatedCategories, { merge: true });
            });
            setNewCategoryName('');
        } catch (error) {
            console.error("Error adding category:", error);
        }
    };

    const handleDeleteCategory = async (type, name) => {
        if (!db || !userId) return;

        const categoryDocRef = doc(db, `/artifacts/${appId}/users/${userId}/settings/categories`);
        try {
            await runTransaction(db, async (transaction) => {
                const categorySnap = await transaction.get(categoryDocRef);
                const currentData = categorySnap.data();

                if (!currentData) return; // Nothing to delete from

                const updatedCategories = {
                    ...currentData,
                    [type]: (currentData[type] || []).filter(cat => cat !== name),
                };
                
                transaction.set(categoryDocRef, updatedCategories, { merge: true });
            });
        } catch (error) {
            console.error("Error deleting category:", error);
        }
    };

    return (
        <>
            <h4 className={`text-xl font-semibold ${textHeading} mb-4`}>Manage Custom Categories</h4>
            
            <form onSubmit={handleAddCategory} className={`flex flex-col sm:flex-row gap-2 mb-6 p-4 border rounded-lg ${cardBg} ${border}`}>
                <select 
                    value={newCategoryType} onChange={(e) => setNewCategoryType(e.target.value)}
                    className={`p-2 border rounded-lg sm:w-28 ${inputBg}`}
                >
                    <option value="Income">Income</option>
                    <option value="Expense">Expense</option>
                </select>
                <input
                    type="text" required placeholder="New Category Name"
                    value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)}
                    className={`p-2 border rounded-lg flex-grow ${inputBg}`}
                />
                <button type="submit" className="bg-green-500 text-white px-4 py-2 rounded-lg font-semibold hover:bg-green-600">Add</button>
            </form>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {['Income', 'Expense'].map(type => (
                    <div key={type} className={`border rounded-lg p-3 shadow-sm ${itemBg} ${border}`}>
                        <h5 className={`font-bold mb-2 text-md ${theme === 'dark' ? 'text-white' : 'text-gray-800'}`}>{type} Categories</h5>
                        <ul className={`divide-y text-sm ${theme === 'dark' ? 'divide-gray-700' : 'divide-gray-200'}`}>
                            {categories[type].map(cat => (
                                <li key={cat} className="flex justify-between items-center py-1.5">
                                    <span className={subText}>{cat}</span>
                                    <button 
                                        onClick={() => handleDeleteCategory(type, cat)}
                                        className="text-red-500 hover:text-red-700 p-1"
                                        title="Delete Category"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>
        </>
    );
};

// 3. Recurring View
// Takes input in selected display currency and converts to USD for storage
const RecurringView = ({
    theme, textHeading, cardBg, border, inputBg, itemBg, subText,
    db, userId, appId, categories, recurringTemplates,
    formatCurrency, displayCurrencyCode, exchangeRates
}) => {
    const [recAmount, setRecAmount] = useState(''); // This is in display currency
    const [recType, setRecType] = useState('Expense');
    const [recCategory, setRecCategory] = useState(categories.Expense[0] || '');
    const [recDescription, setRecDescription] = useState('');
    
    const currentRecCategories = categories[recType] || [];
    const currentSymbol = CURRENCIES[displayCurrencyCode]?.symbol || '$';
    
    useEffect(() => {
         setRecCategory(currentRecCategories[0] || '');
    }, [recType, currentRecCategories]);

    const handleAddRecurring = async (e) => {
        e.preventDefault();
        if (!db || !userId || !recAmount) return;

        // Convert the displayed amount back to USD for storage
        const amountUSD = convertToGlobalBase(parseFloat(recAmount), displayCurrencyCode, exchangeRates);

        const newTemplate = {
            amount: amountUSD, // Amount is stored in USD
            type: recType,
            category: recCategory,
            description: recDescription.trim(),
            frequency: 'Monthly',
            lastRun: null,
        };

        try {
            const recurringColRef = collection(db, `/artifacts/${appId}/users/${userId}/recurring`);
            await addDoc(recurringColRef, newTemplate);
            
            setRecAmount('');
            setRecDescription('');
        } catch (error) {
            console.error("Error adding recurring transaction:", error);
        }
    };

    const handleDeleteRecurring = async (id) => {
        if (!db || !userId) return;
        try {
            const templateRef = doc(db, `/artifacts/${appId}/users/${userId}/recurring/${id}`);
            await deleteDoc(templateRef);
        } catch (error) {
            console.error("Error deleting recurring template:", error);
        }
    };

    return (
        <>
            <h4 className={`text-xl font-semibold ${textHeading} mb-4`}>Set Up Recurring Transactions</h4>

            <form onSubmit={handleAddRecurring} className={`p-4 border rounded-lg ${cardBg} ${border} mb-6 grid grid-cols-2 gap-3`}>
                <h5 className={`col-span-2 font-bold mb-2 ${textHeading}`}>New Monthly Recurring Template</h5>
                
                {/* Amount input is now in display currency */}
                <div>
                    <label className={`block text-xs font-medium ${subText} mb-1`}>Amount (in {displayCurrencyCode})</label>
                    <input type="number" required min="0.01" step="0.01" placeholder={`Amount (${currentSymbol})`}
                        value={recAmount} onChange={(e) => setRecAmount(e.target.value)}
                        className={`p-2 border rounded-lg w-full ${inputBg}`}
                    />
                </div>

                <div className="flex flex-col justify-end">
                    <select value={recType} onChange={(e) => setRecType(e.target.value)} className={`p-2 border rounded-lg ${inputBg}`}>
                        <option value="Income">Income</option>
                        <option value="Expense">Expense</option>
                    </select>
                </div>

                <div className="md:col-span-2">
                     <label className={`block text-xs font-medium ${subText} mb-1`}>Category</label>
                    <select required value={recCategory} onChange={(e) => setRecCategory(e.target.value)} className={`p-2 border rounded-lg w-full ${inputBg}`}>
                        {currentRecCategories.length === 0 && <option disabled>Please add a category first</option>}
                        {currentRecCategories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                </div>

                <div className="md:col-span-2">
                    <label className={`block text-xs font-medium ${subText} mb-1`}>Description</label>
                    <input type="text" placeholder="Description (e.g., Rent, Salary)"
                        value={recDescription} onChange={(e) => setRecDescription(e.target.value)}
                        className={`p-2 border rounded-lg w-full ${inputBg}`}
                    />
                </div>

                <button type="submit" className="col-span-2 bg-indigo-500 text-white px-4 py-2 rounded-lg font-semibold hover:bg-indigo-600">
                    Save Template
                </button>
            </form>

            <h5 className={`font-bold mb-2 ${textHeading}`}>Saved Templates</h5>
            <ul className={`divide-y border rounded-lg shadow-sm ${itemBg} ${border} ${theme === 'dark' ? 'divide-gray-700' : 'divide-gray-200'}`}>
                {recurringTemplates.length === 0 ? (
                    <li className={`p-3 text-center ${subText} text-sm`}>No recurring transactions set up.</li>
                ) : (
                    recurringTemplates.map(template => (
                        <li key={template.id} className={`flex justify-between items-center p-3 ${theme === 'dark' ? 'hover:bg-gray-700' : 'hover:bg-gray-50'}`}>
                            <div className="flex flex-col">
                                <span className={`font-medium ${theme === 'dark' ? 'text-white' : 'text-gray-800'}`}>{template.category} ({template.type})</span>
                                <span className={`text-sm ${subText}`}>{template.description || 'No description'}</span>
                                <span className="text-xs text-gray-500">Last Run: {template.lastRun ? new Date(template.lastRun).toLocaleDateString() : 'Never'}</span>
                            </div>
                            <div className="text-right flex items-center">
                                {/* Display converted currency */}
                                <span className={`font-bold ${template.type === 'Income' ? 'text-green-500' : 'text-red-500'} flex items-center`}>
                                    <span className="mr-1.5">{template.type === 'Income' ? <TrendUpIcon /> : <TrendDownIcon />}</span>
                                    {formatCurrency(template.amount, displayCurrencyCode, exchangeRates)}
                                </span>
                                <button 
                                    onClick={() => handleDeleteRecurring(template.id)}
                                    className="text-red-400 hover:text-red-600 ml-3"
                                    title="Delete Template"
                                >
                                    <svg className="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                </button>
                            </div>
                        </li>
                    ))
                )}
            </ul>
        </>
    );
};

// 4. Theme View
const ThemeView = ({ theme, textHeading, cardBg, border, btnHover, subText, setTheme }) => (
    <>
        <h4 className={`text-xl font-semibold ${textHeading} mb-4`}>Theme & Preferences</h4>
        <div className={`p-4 border rounded-lg ${cardBg} ${border}`}>
            <label className={`block text-sm font-medium ${subText} mb-2`}>Appearance</label>
            <div className="flex space-x-2">
                <button
                    onClick={() => setTheme('light')}
                    className={`flex-1 p-3 rounded-lg border-2 ${theme === 'light' ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900' : `${border} ${btnHover}`}`}
                >
                    <span className={theme === 'dark' ? 'text-white' : 'text-black'}>Light</span>
                </button>
                <button
                    onClick={() => setTheme('dark')}
                    className={`flex-1 p-3 rounded-lg border-2 ${theme === 'dark' ? 'border-indigo-500 bg-indigo-900' : `${border} ${btnHover}`}`}
                >
                    <span className={theme === 'dark' ? 'text-white' : 'text-black'}>Dark</span>
                </button>
            </div>
        </div>
    </>
);

// 5. Reset View
const ResetView = ({ theme, textHeading, cardBg, subText, setShowConfirmResetModal }) => (
    <>
        <h4 className="text-xl font-semibold text-red-500 mb-4">Reset All Data</h4>
        <div className={`p-4 border rounded-lg ${cardBg} border-red-500/30`}>
            <p className={`${subText} mb-4`}>
                This is a permanent action and cannot be undone. This will delete all your transactions, recurring templates, and custom settings (like your budget goal and categories).
            </p>
            <button
                onClick={() => {
                    // Open the confirmation modal
                    setShowConfirmResetModal(true);
                }}
                className="w-full bg-red-600 text-white font-bold py-2 px-4 rounded-lg shadow-md hover:bg-red-700 transition duration-150"
            >
                I understand, Reset All My Data
            </button>
        </div>
    </>
);


// ---
// --- MAIN APPLICATION COMPONENT
// ---
const App = () => {
    // Firebase State
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);

    // Data and UI State
    const [transactions, setTransactions] = useState([]);
    const [monthlyGoalUSD, setMonthlyGoalUSD] = useState(null); // Goal is stored in USD
    const [userCategories, setUserCategories] = useState({ 
        Income: DEFAULT_INCOME_CATEGORIES, 
        Expense: DEFAULT_EXPENSE_CATEGORIES 
    });
    const [recurringTemplates, setRecurringTemplates] = useState([]);

    const [isLoading, setIsLoading] = useState(true);
    const [showGoalModal, setShowGoalModal] = useState(false);
    const [showTransactionModal, setShowTransactionModal] = useState(false);
    const [showConfigModal, setShowConfigModal] = useState(false);
    const [showConfirmResetModal, setShowConfirmResetModal] = useState(false);
    const [currentView, setCurrentView] = useState('Dashboard'); // 'Dashboard' or 'Report'
    
    // Theme State
    const [theme, setTheme] = useState(() => {
        const savedTheme = localStorage.getItem('finance-tracker-theme');
        return savedTheme || 'light'; // Default to 'light'
    });

    // Currency and Filter State
    const [displayCurrencyCode, setDisplayCurrencyCode] = useState('INR'); // Default to INR
    const [exchangeRates, setExchangeRates] = useState(
        Object.keys(CURRENCIES).reduce((acc, code) => {
            acc[code] = CURRENCIES[code].rate; // Use placeholders initially
            return acc;
        }, {})
    );
    const [ratesLoading, setRatesLoading] = useState(true);
    
    const currentYear = new Date().getFullYear();
    const [filterMonth, setFilterMonth] = useState((new Date().getMonth() + 1).toString());
    const [filterYear, setFilterYear] = useState(currentYear.toString());

    const years = useMemo(() => {
        const y = [];
        for (let i = currentYear; i >= currentYear - 5; i--) {
            y.push(i.toString());
        }
        return y;
    }, [currentYear]);

    // Apply theme to <html> element
    useEffect(() => {
        const root = window.document.documentElement;
        if (theme === 'dark') {
            root.classList.add('dark');
        } else {
            root.classList.remove('dark');
        }
        localStorage.setItem('finance-tracker-theme', theme);
    }, [theme]);

    // --- 1. FETCH EXCHANGE RATES ---
    useEffect(() => {
        const fetchRates = async () => {
            setRatesLoading(true);
            try {
                // Using a free, no-key API. In a real app, use a reliable, keyed API.
                const response = await fetch(`https://api.exchangerate-api.com/v4/latest/${BASE_CURRENCY}`);
                if (!response.ok) throw new Error('Failed to fetch rates');
                
                const data = await response.json();
                
                // Update our rates state
                const newRates = {};
                Object.keys(CURRENCIES).forEach(code => {
                    if (data.rates[code]) {
                        newRates[code] = data.rates[code];
                    } else {
                        newRates[code] = exchangeRates[code]; // Keep placeholder if not found
                    }
                });
                newRates[BASE_CURRENCY] = 1; // Ensure base is always 1
                setExchangeRates(newRates);
                
            } catch (error) {
                console.error("Error fetching exchange rates:", error);
                // In case of error, we'll just use the placeholder rates
            } finally {
                setRatesLoading(false);
            }
        };
        
        fetchRates();
        // Fetch rates once on load.
    }, []);


    // --- 2. FIREBASE INITIALIZATION AND AUTHENTICATION ---
    useEffect(() => {
        if (!firebaseConfig || Object.keys(firebaseConfig).length === 0) {
            console.error("Firebase config is missing or empty.");
            setIsLoading(false);
            return;
        }
        try {
            const app = initializeApp(firebaseConfig);
            const firestoreDb = getFirestore(app);
            const firebaseAuth = getAuth(app);
            
            setDb(firestoreDb);
            setAuth(firebaseAuth);

            const unsubscribeAuth = onAuthStateChanged(firebaseAuth, async (user) => {
                let currentUid;
                if (user) {
                    currentUid = user.uid;
                } else {
                    try {
                        if (initialAuthToken) {
                            await signInWithCustomToken(firebaseAuth, initialAuthToken);
                        } else {
                            await signInAnonymously(firebaseAuth);
                        }
                        currentUid = firebaseAuth.currentUser.uid;
                    } catch (authError) {
                        console.error("Authentication Error:", authError);
                        if (!firebaseAuth.currentUser) {
                             await signInAnonymously(firebaseAuth);
                             currentUid = firebaseAuth.currentUser.uid;
                        }
                    }
                }
                setUserId(currentUid);
                // We set loading false only when both auth is ready AND rates are ready
                // The rates fetch will set loading false if it finishes *after* auth.
            });

            return () => unsubscribeAuth();
        } catch (error) {
            console.error("Firebase initialization failed:", error);
            setIsLoading(false);
        }
    }, []);

    // Combined Loading State
    useEffect(() => {
        if (userId && !ratesLoading) {
            setIsLoading(false);
        }
    }, [userId, ratesLoading]);


    // --- 3. LISTEN FOR SETTINGS (GOAL, CATEGORIES, RECURRING) ---
    useEffect(() => {
        if (!db || !userId) return;

        // Listener for Budget Goal (monthlyGoalUSD)
        const goalDocRef = doc(db, `/artifacts/${appId}/users/${userId}/settings/budget`);
        const unsubscribeGoal = onSnapshot(goalDocRef, (docSnap) => {
            if (docSnap.exists() && docSnap.data().monthlyGoalUSD !== undefined) {
                setMonthlyGoalUSD(docSnap.data().monthlyGoalUSD);
            } else {
                setMonthlyGoalUSD(null); // Explicitly set to null if not found
            }
        }, (error) => console.error("Error listening to budget goal:", error));

        // Listener for Categories
        const categoryDocRef = doc(db, `/artifacts/${appId}/users/${userId}/settings/categories`);
        const unsubscribeCategories = onSnapshot(categoryDocRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                setUserCategories({
                    Income: data.Income && data.Income.length > 0 ? data.Income : DEFAULT_INCOME_CATEGORIES,
                    Expense: data.Expense && data.Expense.length > 0 ? data.Expense : DEFAULT_EXPENSE_CATEGORIES,
                });
            } else {
                 setDoc(categoryDocRef, { 
                    Income: DEFAULT_INCOME_CATEGORIES, 
                    Expense: DEFAULT_EXPENSE_CATEGORIES 
                }, { merge: true }).catch(err => console.error("Error setting default categories:", err));
            }
        }, (error) => console.error("Error listening to categories:", error));

        // Listener for Recurring Templates
        const recurringColRef = collection(db, `/artifacts/${appId}/users/${userId}/recurring`);
        const qRecurring = query(recurringColRef);
        const unsubscribeRecurring = onSnapshot(qRecurring, (snapshot) => {
            const templates = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            templates.sort((a, b) => a.category.localeCompare(b.category));
            setRecurringTemplates(templates);
        }, (error) => console.error("Error listening to recurring templates:", error));


        return () => {
            unsubscribeGoal();
            unsubscribeCategories();
            unsubscribeRecurring();
        };
    }, [db, userId]);


    // --- 4. REAL-TIME DATA LISTENER (TRANSACTIONS) ---
    useEffect(() => {
        if (!db || !userId) return;

        const transactionsColRef = collection(db, `/artifacts/${appId}/users/${userId}/transactions`);
        const q = query(transactionsColRef, orderBy('timestamp', 'desc'));

        const unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
            const fetchedTransactions = [];
            snapshot.forEach((doc) => {
                fetchedTransactions.push({ id: doc.id, ...doc.data() });
            });
            setTransactions(fetchedTransactions);
        }, (error) => {
            console.error("Error listening to transactions:", error);
        });

        return () => unsubscribeSnapshot();
    }, [db, userId]);

    // --- 5. AUTOMATED RECURRING TRANSACTION LOGIC ---
    const runRecurringTransactions = useCallback(async () => {
        if (!db || !userId || recurringTemplates.length === 0) return;

        const transactionsColRef = collection(db, `/artifacts/${appId}/users/${userId}/transactions`);
        const batch = writeBatch(db);
        const today = new Date();
        const currentMonth = today.getMonth();
        const currentYear = today.getFullYear();
        const nowTimestamp = Date.now();
        
        let operationsCount = 0;

        for (const template of recurringTemplates) {
            const lastRunDate = template.lastRun ? new Date(template.lastRun) : new Date(0);
            
            if (lastRunDate.getMonth() !== currentMonth || lastRunDate.getFullYear() !== currentYear) {
                
                const newTransaction = {
                    amount: template.amount, // Amount is already in USD
                    type: template.type,
                    category: template.category,
                    description: `[Recurring] ${template.description || template.category}`,
                    timestamp: nowTimestamp
                };

                const newTransactionRef = doc(collection(db, `/artifacts/${appId}/users/${userId}/transactions`));
                batch.set(newTransactionRef, newTransaction);
                operationsCount++;

                const templateRef = doc(db, `/artifacts/${appId}/users/${userId}/recurring/${template.id}`);
                batch.update(templateRef, { lastRun: nowTimestamp });
                operationsCount++;
            }
        }

        if (operationsCount > 0) {
            console.log(`Processing ${operationsCount / 2} recurring transactions...`);
            try {
                await batch.commit();
            } catch (error) {
                console.error("Error running recurring transactions batch:", error);
            }
        }
    }, [db, userId, recurringTemplates]);

    // Run recurring transaction logic on load/template change
    useEffect(() => {
        if (db && userId) {
            runRecurringTransactions();
        }
    }, [db, userId, runRecurringTransactions]);


    // --- 6. DATA PROCESSING (Filtering and Summarizing) ---
    // ALL calculations are done in BASE_CURRENCY (USD)
    const calculateSummary = useCallback((data, month, year) => {
        let totalIncome = 0;
        let totalExpense = 0;
        const expensesByCategory = {};

        const filtered = data.filter(t => 
            isTransactionInPeriod(t.timestamp, month, year)
        );

        filtered.forEach(t => {
            if (t.type === 'Income') {
                totalIncome += t.amount;
            } else if (t.type === 'Expense') {
                totalExpense += t.amount;
                const categoryKey = t.category.trim() || 'Uncategorized';
                expensesByCategory[categoryKey] = (expensesByCategory[categoryKey] || 0) + t.amount;
            }
        });

        const currentBalance = totalIncome - totalExpense;

        // Format expense data for the Pie Chart
        const expenseData = Object.keys(expensesByCategory).map((category, index) => ({
            name: category,
            value: expensesByCategory[category], // Value is in USD
            fill: COLORS[index % COLORS.length]
        }));

        return { 
            summary: { balance: currentBalance, income: totalIncome, expense: totalExpense }, 
            filteredTransactions: filtered, 
            expenseCategoryData: expenseData 
        };
    }, []);

    // Memoized Summary for Dashboard
    const dashboardData = useMemo(() => 
        calculateSummary(transactions, filterMonth, filterYear)
    , [transactions, filterMonth, filterYear, calculateSummary]);


    // --- 7. BUDGET GOAL MANAGEMENT ---
    // Saves the goal in USD
    const handleSaveGoal = async (newGoalAmountDisplayed) => {
        if (!db || !userId) return;

        const newGoal = parseFloat(newGoalAmountDisplayed);
        if (isNaN(newGoal) || newGoal < 0) {
            console.error("Invalid goal amount");
            return;
        }
        
        // Convert displayed currency amount back to USD for storage
        const newGoalUSD = convertToGlobalBase(newGoal, displayCurrencyCode, exchangeRates);

        const goalDocRef = doc(db, `/artifacts/${appId}/users/${userId}/settings/budget`);
        try {
            await setDoc(goalDocRef, { monthlyGoalUSD: newGoalUSD }, { merge: true });
            setMonthlyGoalUSD(newGoalUSD); // Set the state to the USD value
            setShowGoalModal(false);
        } catch (error) {
            console.error("Error saving goal:", error);
        }
    };

    // --- 8. DATA RESET ---
    const handleResetAllData = async () => {
        if (!db || !userId) return;

        console.log("Initiating data reset...");
        setShowConfirmResetModal(false);
        setShowConfigModal(false);
        setIsLoading(true);

        try {
            // 1. Delete all transactions
            const transactionsColRef = collection(db, `/artifacts/${appId}/users/${userId}/transactions`);
            const transactionsSnapshot = await getDocs(transactionsColRef);
            let batch = writeBatch(db);
            let count = 0;
            transactionsSnapshot.forEach((doc) => {
                batch.delete(doc.ref);
                count++;
                if (count >= 499) { // Batch limit is 500
                    batch.commit();
                    batch = writeBatch(db);
                    count = 0;
                }
            });
            await batch.commit();
            console.log("Deleted transactions.");

            // 2. Delete all recurring templates
            const recurringColRef = collection(db, `/artifacts/${appId}/users/${userId}/recurring`);
            const recurringSnapshot = await getDocs(recurringColRef);
            batch = writeBatch(db);
            recurringSnapshot.forEach((doc) => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log("Deleted recurring templates.");

            // 3. Reset settings
            const categoryDocRef = doc(db, `/artifacts/${appId}/users/${userId}/settings/categories`);
            await setDoc(categoryDocRef, { 
                Income: DEFAULT_INCOME_CATEGORIES, 
                Expense: DEFAULT_EXPENSE_CATEGORIES 
            });
            
            const goalDocRef = doc(db, `/artifacts/${appId}/users/${userId}/settings/budget`);
            await setDoc(goalDocRef, { monthlyGoalUSD: null }); // Reset goal to null
            
            console.log("Reset settings.");
            
        } catch (error) {
            console.error("Error resetting data:", error);
        } finally {
            setIsLoading(false);
        }
    };


    // --- 9. UI COMPONENTS ---

    const LoadingSpinner = () => (
        <div className="text-center p-8">
            <svg className="animate-spin h-8 w-8 text-indigo-500 mx-auto" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p className={`mt-2 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-600'}`}>
                {ratesLoading ? 'Fetching exchange rates...' : 'Initializing database...'}
            </p>
        </div>
    );

    // Displays CONVERTED currency
    const SummaryCard = ({ title, baseValue, bgColor }) => (
        <div className={`${bgColor} text-white p-4 sm:p-6 rounded-lg shadow-lg flex flex-col justify-between`}>
            <p className="text-sm uppercase font-semibold opacity-80">{title}</p>
            <p className="text-2xl sm:text-3xl font-extrabold mt-1">
                {formatCurrency(baseValue, displayCurrencyCode, exchangeRates)}
            </p>
        </div>
    );
    
    // Displays CONVERTED currency
    const GoalCard = ({ summary }) => {
        const bgColor = theme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200';
        const textColor = theme === 'dark' ? 'text-gray-300' : 'text-gray-700';
        const headingColor = theme === 'dark' ? 'text-white' : 'text-gray-800';
        const valueColor = theme === 'dark' ? 'text-indigo-400' : 'text-indigo-600';
        const subTextColor = theme === 'dark' ? 'text-gray-400' : 'text-gray-500';
        
        // No goal set state
        if (monthlyGoalUSD === null) {
            return (
                <div className={`p-4 sm:p-6 rounded-lg shadow-lg border col-span-full flex flex-col items-center justify-center text-center ${bgColor}`}>
                    <p className={`text-lg font-semibold ${textColor} mb-3`}>You haven't set a monthly goal.</p>
                    <button
                        onClick={() => {
                            setShowConfigModal(false);
                            setShowGoalModal(true);
                        }}
                        className="bg-indigo-600 text-white font-semibold py-2 px-5 rounded-lg shadow-md hover:bg-indigo-700 transition duration-150"
                    >
                        Set Expense Goal
                    </button>
                </div>
            );
        }
        
        // All calculations in USD
        const percentage = monthlyGoalUSD > 0 ? Math.min(100, (summary.expense / monthlyGoalUSD) * 100) : (summary.expense > 0 ? 100 : 0);
        const remainingUSD = monthlyGoalUSD - summary.expense;
        const isOverBudget = remainingUSD < 0;
        const progressBarColor = isOverBudget ? 'bg-red-500' : (percentage > 75 ? 'bg-yellow-500' : 'bg-green-500');

        return (
            <div className={`p-4 sm:p-6 rounded-lg shadow-lg border col-span-full ${bgColor}`}>
                <div className="flex justify-between items-start mb-3">
                    <div>
                        <p className={`text-lg font-semibold ${isOverBudget ? 'text-red-500' : headingColor}`}>
                            {isOverBudget ? '⚠️ Budget Exceeded' : 'Monthly Expense Goal'}
                        </p>
                        {/* Display is CONVERTED */}
                        <p className={`text-2xl font-bold ${valueColor}`}>
                            {formatCurrency(summary.expense, displayCurrencyCode, exchangeRates)} 
                            <span className={`${subTextColor} text-sm`}> / {formatCurrency(monthlyGoalUSD, displayCurrencyCode, exchangeRates)}</span>
                        </p>
                        <p className={`text-sm ${isOverBudget ? 'text-red-500' : 'text-green-600'} font-medium mt-1`}>
                            {/* Display remaining CONVERTED */}
                            {isOverBudget 
                                ? `${formatCurrency(Math.abs(remainingUSD), displayCurrencyCode, exchangeRates)} Over Budget` 
                                : `${formatCurrency(remainingUSD, displayCurrencyCode, exchangeRates)} Remaining`}
                        </p>
                    </div>
                </div>
                {/* Progress Bar */}
                <div className={`w-full rounded-full h-2.5 ${theme === 'dark' ? 'bg-gray-700' : 'bg-gray-200'}`}>
                    <div className={`h-2.5 rounded-full transition-all duration-500 ${progressBarColor}`} style={{ width: `${percentage}%` }}></div>
                </div>
            </div>
        );
    };

    // Goal modal now takes input in DISPLAYED currency
    const GoalModal = ({ goalUSD, onSave, onClose }) => {
        // Convert the stored USD goal to the displayed currency for editing
        const initialDisplayGoal = useMemo(() => {
            if (goalUSD === null || goalUSD === undefined) return '';
            const rate = exchangeRates[displayCurrencyCode] || 1;
            return (goalUSD * rate).toFixed(2);
        }, [goalUSD, displayCurrencyCode, exchangeRates]);

        const [newGoal, setNewGoal] = useState(initialDisplayGoal);

        const handleModalSubmit = (e) => {
            e.preventDefault();
            if (newGoal !== '' && newGoal >= 0) {
                onSave(newGoal); // onSave now expects the *displayed* currency value
            }
        };
        
        const currentSymbol = CURRENCIES[displayCurrencyCode]?.symbol || '$';
        const modalBg = theme === 'dark' ? 'bg-gray-800' : 'bg-white';
        const textLabel = theme === 'dark' ? 'text-gray-300' : 'text-gray-700';
        const textHeading = theme === 'dark' ? 'text-white' : 'text-gray-800';
        const inputBg = theme === 'dark' ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-black';
        const btnCancel = theme === 'dark' ? 'bg-gray-600 text-gray-200 hover:bg-gray-500' : 'bg-gray-100 text-gray-600 hover:bg-gray-200';

        return (
            <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4" onClick={onClose}>
                <div className={`${modalBg} rounded-xl shadow-2xl w-full max-w-sm p-6`} onClick={(e) => e.stopPropagation()}>
                    <h3 className={`text-xl font-bold ${textHeading} mb-4`}>Set Monthly Expense Goal</h3>
                    <form onSubmit={handleModalSubmit}>
                        <label htmlFor="goal-amount" className={`block text-sm font-medium ${textLabel} mb-2`}>
                            Goal Amount (in {displayCurrencyCode})
                        </label>
                        <input
                            type="number"
                            id="goal-amount"
                            min="0"
                            step="0.01"
                            required
                            placeholder={`e.g., 50000.00 (${currentSymbol})`}
                            value={newGoal}
                            onChange={(e) => setNewGoal(e.target.value)}
                            className={`w-full p-3 border rounded-lg focus:ring-indigo-500 focus:border-indigo-500 mb-6 ${inputBg}`}
                        />
                        <div className="flex justify-end space-x-3">
                            <button
                                type="button"
                                onClick={onClose}
                                className={`px-4 py-2 text-sm font-semibold rounded-lg ${btnCancel}`}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="px-4 py-2 text-sm font-semibold text-white bg-indigo-500 rounded-lg hover:bg-indigo-600 shadow-md"
                            >
                                Save Goal
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        );
    };

    // Displays CONVERTED currency
    const ExpenseChart = ({ expenseCategoryData }) => {
        const cardBg = theme === 'dark' ? 'bg-gray-800' : 'bg-white';
        const headingColor = theme === 'dark' ? 'text-white' : 'text-gray-700';
        const textColor = theme === 'dark' ? 'text-gray-400' : 'text-gray-500';
        
        if (expenseCategoryData.length === 0) {
            return (
                <div className={`text-center p-8 ${textColor} ${theme === 'dark' ? 'bg-gray-800' : 'bg-gray-50'} rounded-lg mt-8`}>
                    No expense data for the selected period.
                </div>
            );
        }
        
        // Sum of USD values
        totalValueForPie = expenseCategoryData.reduce((sum, item) => sum + item.value, 0);

        // Calculate data with percentages for the legend/label
        const pieData = expenseCategoryData.map(item => ({
            ...item,
            percent: ((item.value / totalValueForPie) * 100).toFixed(1),
            // CONVERT USD value for display
            label: `${item.name}: ${formatCurrency(item.value, displayCurrencyCode, exchangeRates)}`,
        }));


        // Mock payload for the Legend component
        const legendPayload = pieData.map(item => ({
            value: `${item.name} (${item.percent}%)`,
            type: 'circle',
            color: item.fill,
            payload: { value: formatCurrency(item.value, displayCurrencyCode, exchangeRates) } 
        }));

        return (
            <div className={`w-full p-6 rounded-xl shadow-lg mt-8 ${cardBg}`}>
                <h2 className={`text-xl font-semibold ${headingColor} mb-4`}>Expense Distribution by Category ({CURRENCIES[displayCurrencyCode].symbol})</h2>
                <div className="flex flex-col md:flex-row items-center justify-around">
                    <Recharts.PieChart width={300} height={200}>
                        <Recharts.Pie
                            data={pieData}
                            cx={150}
                            cy={100}
                            innerRadius={50}
                            outerRadius={80}
                            dataKey="value" // dataKey remains 'value' (USD)
                            nameKey="name"
                        >
                        </Recharts.Pie>
                    </Recharts.PieChart>
                    <div className={`md:w-1/2 mt-4 md:mt-0 ${textColor}`}>
                        <Recharts.Legend payload={legendPayload} />
                    </div>
                </div>
            </div>
        );
    };

    const FilterAndCurrencyCard = () => (
        <div className={`p-4 sm:p-6 rounded-lg shadow-lg border mb-6 ${theme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
            <h2 className={`text-lg font-semibold mb-4 ${theme === 'dark' ? 'text-white' : 'text-gray-700'}`}>Display and Filtering Options</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                
                {/* 1. Currency Selector */}
                <div className="col-span-1">
                    <label htmlFor="currency-select" className={`block text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>Display Currency</label>
                    <select
                        id="currency-select"
                        value={displayCurrencyCode}
                        onChange={(e) => setDisplayCurrencyCode(e.target.value)}
                        className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2.5 focus:border-indigo-500 focus:ring-indigo-500 ${theme === 'dark' ? 'bg-gray-700 text-white border-gray-600' : 'bg-white text-black'}`}
                    >
                        {Object.keys(CURRENCIES).map((code) => (
                            <option key={code} value={code}>
                                {CURRENCIES[code].name} ({CURRENCIES[code].symbol})
                            </option>
                        ))}
                    </select>
                    {/* --- ADDED LIVE RATE DISPLAY --- */}
                    {displayCurrencyCode !== BASE_CURRENCY && (
                        <p className={`text-xs mt-2 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                            Live Rate: 1 {BASE_CURRENCY} = {exchangeRates[displayCurrencyCode]?.toFixed(2)} {displayCurrencyCode}
                        </p>
                    )}
                </div>

                {/* 2. Filter Month */}
                <div className="col-span-1">
                    <label htmlFor="filter-month" className={`block text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>Filter Month</label>
                    <select 
                        id="filter-month" 
                        value={filterMonth} 
                        onChange={(e) => setFilterMonth(e.target.value)}
                        className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2.5 focus:border-indigo-500 focus:ring-indigo-500 ${theme === 'dark' ? 'bg-gray-700 text-white border-gray-600' : 'bg-white text-black'}`}
                    >
                        <option value="">All Months</option>
                        {Array.from({ length: 12 }, (_, i) => i + 1).map(month => (
                            <option key={month} value={month.toString()}>
                                {new Date(0, month - 1).toLocaleString('default', { month: 'long' })}
                            </option>
                        ))}
                    </select>
                </div>

                {/* 3. Filter Year */}
                <div className="flex-1">
                    <label htmlFor="filter-year" className={`block text-sm font-medium ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>Filter Year</label>
                    <select 
                        id="filter-year" 
                        value={filterYear} 
                        onChange={(e) => setFilterYear(e.target.value)}
                        className={`mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2.5 focus:border-indigo-500 focus:ring-indigo-500 ${theme === 'dark' ? 'bg-gray-700 text-white border-gray-600' : 'bg-white text-black'}`}
                    >
                        <option value="">All Years</option>
                        {years.map(year => (
                            <option key={year} value={year}>
                                {year}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
        </div>
    );

    // Displays CONVERTED currency
    const TransactionList = ({ filteredTransactions }) => {
        const listBg = theme === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200';
        const headingColor = theme === 'dark' ? 'text-white' : 'text-gray-700';
        const emptyTextColor = theme === 'dark' ? 'text-gray-400' : 'text-gray-500';
        const itemHover = theme === 'dark' ? 'hover:bg-gray-700' : 'hover:bg-gray-50';
        const itemColor = theme === 'dark' ? 'text-gray-200' : 'text-gray-900';
        const subItemColor = theme === 'dark' ? 'text-gray-400' : 'text-gray-500';
        const dateColor = theme === 'dark' ? 'text-gray-500' : 'text-gray-400';
        const incomeTagBg = theme === 'dark' ? 'bg-green-900/50' : 'bg-green-50';
        const expenseTagBg = theme === 'dark' ? 'bg-red-900/50' : 'bg-red-50';

        return (
            <>
                <h2 className={`text-xl font-semibold ${headingColor} mb-4 mt-8`}>Transaction History (Filtered)</h2>
                <div id="transaction-list-container" className={`rounded-lg border shadow-lg max-h-96 overflow-y-auto ${listBg}`}>
                    <ul className={`divide-y ${theme === 'dark' ? 'divide-gray-700' : 'divide-gray-200'}`}>
                        {filteredTransactions.length === 0 ? (
                            <li className={`p-4 text-center ${emptyTextColor}`}>No transactions recorded for this period.</li>
                        ) : (
                            filteredTransactions.map(transaction => {
                                const isIncome = transaction.type === 'Income';
                                const colorClass = isIncome ? 'text-green-500' : 'text-red-500';
                                const tagBg = isIncome ? incomeTagBg : expenseTagBg;

                                return (
                                    <li key={transaction.id} className={`flex justify-between items-center p-4 ${itemHover} transition duration-100`}>
                                        <div className="flex flex-col flex-grow">
                                            <span className={`font-medium ${itemColor}`}>{transaction.category}</span>
                                            <span className={`text-sm ${subItemColor}`}>{transaction.description || 'No description'}</span>
                                        </div>
                                        <div className="flex flex-col items-end">
                                            {/* CONVERTED amount */}
                                            <span className={`font-bold ${colorClass} ${tagBg} px-3 py-1 rounded-full text-sm flex items-center`}>
                                                <span className="mr-1.5">{isIncome ? <TrendUpIcon /> : <TrendDownIcon />}</span>
                                                {formatCurrency(transaction.amount, displayCurrencyCode, exchangeRates)}
                                            </span>
                                            <span className={`text-xs ${dateColor} mt-1`}>
                                                {new Date(transaction.timestamp).toLocaleString(undefined, {
                                                    year: 'numeric',
                                                    month: 'short',
                                                    day: 'numeric',
                                                    hour: '2-digit',
                                                    minute: '2-digit',
                                                })}
                                            </span>
                                        </div>
                                    </li>
                                );
                            })
                        )}
                    </ul>
                </div>
            </>
        );
    }

    // Modal now takes input in DISPLAYED currency
    const AddTransactionModal = () => {
        const [modalAmount, setModalAmount] = useState(''); // This is in display currency
        const [modalType, setModalType] = useState('Expense');
        const [modalCategory, setModalCategory] = useState(userCategories.Expense[0]);
        const [modalDescription, setModalDescription] = useState('');
        const [modalDateTime, setModalDateTime] = useState(() => getModalDefaultDate(filterMonth, filterYear));

        const currentCategories = userCategories[modalType] || [];

        useEffect(() => {
            setModalCategory(currentCategories[0] || '');
        }, [modalType, currentCategories]);
        
        useEffect(() => {
            if (showTransactionModal) {
                setModalDateTime(getModalDefaultDate(filterMonth, filterYear));
                setModalAmount('');
                setModalDescription('');
                setModalType('Expense');
            }
        }, [showTransactionModal, filterMonth, filterYear]);

        const handleModalSubmit = async (e) => {
            e.preventDefault();
            
            if (!db || !userId || !modalAmount || !modalCategory || !modalDateTime) {
                console.error("Please fill in all required fields.");
                return;
            }

            const timestamp = new Date(modalDateTime).getTime();
            if (isNaN(timestamp)) {
                console.error("Invalid date/time value.");
                return;
            }

            // Convert the displayed amount back to USD for storage
            const amountUSD = convertToGlobalBase(parseFloat(modalAmount), displayCurrencyCode, exchangeRates);

            const newTransaction = {
                amount: amountUSD, // Amount is stored in USD
                type: modalType,
                category: modalCategory, 
                description: modalDescription.trim(),
                timestamp: timestamp 
            };

            try {
                const transactionsColRef = collection(db, `/artifacts/${appId}/users/${userId}/transactions`);
                await addDoc(transactionsColRef, newTransaction);
                setShowTransactionModal(false);
            } catch (error) {
                console.error("Error adding document: ", error);
            }
        };

        if (!showTransactionModal) return null;
        
        const currentSymbol = CURRENCIES[displayCurrencyCode]?.symbol || '$';
        const modalBg = theme === 'dark' ? 'bg-gray-800' : 'bg-white';
        const textLabel = theme === 'dark' ? 'text-gray-300' : 'text-gray-700';
        const textHeading = theme === 'dark' ? 'text-white' : 'text-gray-800';
        const inputBg = theme === 'dark' ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400' : 'bg-white border-gray-300 text-black';
        const tabRing = theme === 'dark' ? 'border-gray-700' : 'border-gray-200';
        const tabText = theme === 'dark' ? 'text-gray-300' : 'text-gray-700';
        const tabHover = theme === 'dark' ? 'hover:bg-gray-700' : 'hover:bg-gray-100';

        return (
            <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4" onClick={() => setShowTransactionModal(false)}>
                <div className={`${modalBg} rounded-xl shadow-2xl w-full max-w-lg p-6`} onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-between items-center mb-6">
                        <h3 className={`text-2xl font-bold ${textHeading}`}>Add Transaction</h3>
                        <button onClick={() => setShowTransactionModal(false)} className={`${tabText} ${tabHover} p-1 rounded-full`}>
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                        </button>
                    </div>

                    <div className={`flex border-2 ${tabRing} rounded-lg mb-6 p-1`}>
                        <button
                            type="button"
                            onClick={() => setModalType('Income')}
                            className={`flex-1 py-2 text-center text-base font-semibold rounded-lg transition-colors duration-150 ${
                                modalType === 'Income' ? 'bg-green-500 text-white shadow-md' : `${tabText} ${theme === 'dark' ? 'hover:bg-green-900' : 'hover:bg-green-50'}`
                            }`}
                        >
                            Income
                        </button>
                        <button
                            type="button"
                            onClick={() => setModalType('Expense')}
                            className={`flex-1 py-2 text-center text-base font-semibold rounded-lg transition-colors duration-150 ${
                                modalType === 'Expense' ? 'bg-red-500 text-white shadow-md' : `${tabText} ${theme === 'dark' ? 'hover:bg-red-900' : 'hover:bg-red-50'}`
                            }`}
                        >
                            Expense
                        </button>
                    </div>

                    <form onSubmit={handleModalSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        
                        {/* Amount */}
                        <div className="md:col-span-1">
                            {/* Updated Label to show DISPLAYED currency */}
                            <label htmlFor="modal-amount" className={`block text-sm font-medium ${textLabel}`}>Amount (in {displayCurrencyCode})</label>
                            <input 
                                type="number" step="0.01" id="modal-amount" required min="0.01"
                                placeholder={`Amount (${currentSymbol})`}
                                value={modalAmount} onChange={(e) => setModalAmount(e.target.value)}
                                className={`mt-1 block w-full rounded-md shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500 ${inputBg}`}
                                autoFocus
                            />
                        </div>

                        {/* Date & Time */}
                        <div className="md:col-span-1">
                            <label htmlFor="modal-datetime" className={`block text-sm font-medium ${textLabel}`}>Date & Time</label>
                            <input 
                                type="datetime-local" id="modal-datetime" required
                                value={modalDateTime} onChange={(e) => setModalDateTime(e.target.value)}
                                className={`mt-1 block w-full rounded-md shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500 ${inputBg}`}
                            />
                        </div>

                        {/* Category DROP DOWN (Dynamic) */}
                        <div className="md:col-span-2">
                            <label htmlFor="modal-category" className={`block text-sm font-medium ${textLabel}`}>Category ({modalType})</label>
                            <select
                                id="modal-category"
                                required
                                value={modalCategory} 
                                onChange={(e) => setModalCategory(e.target.value)}
                                className={`mt-1 block w-full rounded-md shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500 ${inputBg}`} 
                            >
                                {currentCategories.map(category => (
                                    <option key={category} value={category}>{category}</option>
                                ))}
                            </select>
                        </div>

                        {/* Description */}
                        <div className="md:col-span-2">
                            <label htmlFor="modal-description" className={`block text-sm font-medium ${textLabel}`}>Description (Optional)</label>
                            <input 
                                type="text" id="modal-description" 
                                value={modalDescription} onChange={(e) => setModalDescription(e.target.value)}
                                className={`mt-1 block w-full rounded-md shadow-sm p-3 focus:border-indigo-500 focus:ring-indigo-500 ${inputBg}`} 
                                placeholder="Details of the transaction"
                            />
                        </div>

                        {/* Submit Button */}
                        <div className="md:col-span-2 pt-4">
                            <button 
                                type="submit" 
                                disabled={!userId || !modalAmount || !modalDateTime}
                                className={`w-full font-semibold py-3 px-4 rounded-lg shadow-md transition duration-150 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 ${
                                    modalType === 'Income' 
                                        ? 'bg-green-500 hover:bg-green-600 text-white focus:ring-green-500' 
                                        : 'bg-red-500 hover:bg-red-600 text-white focus:ring-red-500'
                                }`}
                            >
                                Record {modalType}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        );
    };

    // Consolidated Modal for all Configuration and Navigation
    const ConfigModal = ({ 
        categories, recurringTemplates, onClose,
        theme, setTheme, db, userId, appId,
        formatCurrency, displayCurrencyCode, exchangeRates,
        setShowConfirmResetModal, setCurrentView, setShowGoalModal
    }) => {
        const [view, setView] = useState('Dashboard'); // 'Dashboard', 'Categories', 'Recurring', 'Report', 'Theme', 'Reset'

        const handleNavAction = (targetView) => {
            if (targetView === 'Report') {
                setCurrentView('Report');
                onClose();
            } else if (targetView === 'Goal') {
                onClose();
                setShowGoalModal(true);
            } else {
                setView(targetView);
            }
        }

        const modalBg = theme === 'dark' ? 'bg-gray-800' : 'bg-white';
        const textHeading = theme === 'dark' ? 'text-white' : 'text-gray-800';
        const subText = theme === 'dark' ? 'text-gray-400' : 'text-gray-600';
        const btnHover = theme === 'dark' ? 'hover:bg-gray-700' : 'hover:bg-gray-100';
        const cardBg = theme === 'dark' ? 'bg-gray-900' : 'bg-gray-50';
        const itemBg = theme === 'dark' ? 'bg-gray-800' : 'bg-white';
        const border = theme === 'dark' ? 'border-gray-700' : 'border-gray-200';
        const inputBg = theme === 'dark' ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-black';


        if (!showConfigModal) return null;

        const isMainView = view === 'Dashboard';

        return (
            <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4" onClick={isMainView ? onClose : () => setView('Dashboard')}>
                <div className={`${modalBg} rounded-xl shadow-2xl w-full max-w-2xl p-6`} onClick={(e) => e.stopPropagation()}>
                    <div className={`flex justify-between items-center mb-6 border-b ${border} pb-3`}>
                        <h3 className={`text-2xl font-bold ${textHeading}`}>
                            {isMainView ? 'Configuration Menu' : 
                             view === 'Categories' ? 'Category Management' :
                             view === 'Recurring' ? 'Recurring Transactions' :
                             view === 'Theme' ? 'Theme & Preferences' :
                             view === 'Reset' ? 'Reset Data' : 'Settings'}
                        </h3>
                        <button onClick={onClose} className={`${subText} ${btnHover} p-1 rounded-full`}>
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                        </button>
                    </div>
                    
                    {!isMainView && (
                        <div className="mb-4">
                            <button onClick={() => setView('Dashboard')} className="flex items-center text-sm font-semibold text-indigo-500 hover:text-indigo-400">
                                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                                Back to Menu
                            </button>
                        </div>
                    )}

                    <div className="max-h-[75vh] overflow-y-auto pr-2">
                        {isMainView && <NavigationView 
                            theme={theme} 
                            textHeading={textHeading} 
                            handleNavAction={handleNavAction} 
                            setView={setView} 
                        />}
                        {view === 'Categories' && <CategoryView 
                            theme={theme} textHeading={textHeading} cardBg={cardBg} border={border} inputBg={inputBg} itemBg={itemBg} subText={subText}
                            db={db} userId={userId} appId={appId} categories={userCategories}
                        />}
                        {view === 'Recurring' && <RecurringView
                            theme={theme} textHeading={textHeading} cardBg={cardBg} border={border} inputBg={inputBg} itemBg={itemBg} subText={subText}
                            db={db} userId={userId} appId={appId} categories={categories} recurringTemplates={recurringTemplates}
                            formatCurrency={formatCurrency} displayCurrencyCode={displayCurrencyCode} exchangeRates={exchangeRates}
                        />}
                        {view === 'Theme' && <ThemeView 
                            theme={theme} textHeading={textHeading} cardBg={cardBg} border={border} btnHover={btnHover} subText={subText}
                            setTheme={setTheme}
                        />}
                        {view === 'Reset' && <ResetView 
                            theme={theme} textHeading={textHeading} cardBg={cardBg} subText={subText}
                            setShowConfirmResetModal={setShowConfirmResetModal}
                        />}
                    </div>
                </div>
            </div>
        );
    };

    // Confirmation Modal for Reset
    const ConfirmResetModal = () => {
        if (!showConfirmResetModal) return null;
        
        const modalBg = theme === 'dark' ? 'bg-gray-800' : 'bg-white';
        const textHeading = theme === 'dark' ? 'text-white' : 'text-gray-800';
        const subText = theme === 'dark' ? 'text-gray-400' : 'text-gray-600';
        const btnCancel = theme === 'dark' ? 'bg-gray-600 text-gray-200 hover:bg-gray-500' : 'bg-gray-100 text-gray-600 hover:bg-gray-200';
        
        return (
            <div className="fixed inset-0 bg-black bg-opacity-70 z-[60] flex justify-center items-center p-4" onClick={() => setShowConfirmResetModal(false)}>
                <div className={`${modalBg} rounded-xl shadow-2xl w-full max-w-md p-6`} onClick={(e) => e.stopPropagation()}>
                    <h3 className={`text-xl font-bold text-red-500 mb-4`}>Are you absolutely sure?</h3>
                    <p className={`${subText} mb-6`}>This action cannot be undone. All your financial data will be permanently deleted.</p>
                    <div className="flex justify-end space-x-3">
                        <button
                            type="button"
                            onClick={() => setShowConfirmResetModal(false)}
                            className={`px-4 py-2 text-sm font-semibold rounded-lg ${btnCancel}`}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleResetAllData}
                            className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 shadow-md"
                        >
                            Yes, Delete Everything
                        </button>
                    </div>
                </div>
            </div>
        );
    };

    // Displays CONVERTED currency
    const ReportView = () => {
        const [reportMonthA, setReportMonthA] = useState((new Date().getMonth() + 1).toString());
        const [reportYearA, setReportYearA] = useState(currentYear.toString());
        const [reportMonthB, setReportMonthB] = useState(((new Date().getMonth()) || 12).toString()); // Previous month
        const [reportYearB, setReportYearB] = useState(new Date().getMonth() === 0 ? (currentYear - 1).toString() : currentYear.toString());

        // Summaries are in USD
        const dataA = useMemo(() => calculateSummary(transactions, reportMonthA, reportYearA), [transactions, reportMonthA, reportYearA, calculateSummary]);
        const dataB = useMemo(() => calculateSummary(transactions, reportMonthB, reportYearB), [transactions, reportMonthB, reportYearB, calculateSummary]);
        
        const cardBg = theme === 'dark' ? 'bg-gray-800' : 'bg-white';
        const headingColor = theme === 'dark' ? 'text-white' : 'text-gray-800';
        const textColor = theme === 'dark' ? 'text-gray-300' : 'text-gray-700';
        const tableHeaderBg = theme === 'dark' ? 'bg-gray-900' : 'bg-gray-100';
        const inputBg = theme === 'dark' ? 'bg-gray-700 text-white border-gray-600' : 'bg-white text-black border-gray-300';
        const border = theme === 'dark' ? 'border-gray-700' : 'border-gray-200';

        const getPeriodLabel = (month, year) => {
            if (!month || !year) return 'All Time';
            const monthName = new Date(0, parseInt(month, 10) - 1).toLocaleString('default', { month: 'long' });
            return `${monthName} ${year}`;
        };

        // ComparisonRow handles USD values and converts for display
        const ComparisonRow = ({ title, valueA_USD, valueB_USD, color }) => {
            const diff = valueA_USD - valueB_USD;
            const percentageChange = valueB_USD !== 0 ? ((diff / Math.abs(valueB_USD)) * 100).toFixed(1) : (valueA_USD !== 0 ? 'N/A' : '0.0');
            
            let diffColor = diff > 0 ? 'text-red-600' : (diff < 0 ? 'text-green-600' : (theme === 'dark' ? 'text-gray-400' : 'text-gray-500')); 
            let symbol = diff > 0 ? <TrendDownIcon /> : (diff < 0 ? <TrendUpIcon /> : <span className="w-5 h-5 text-center">-</span>);

            if (title.includes('Income') || title.includes('Balance')) {
                diffColor = diff > 0 ? 'text-green-600' : (diff < 0 ? 'text-red-600' : (theme === 'dark' ? 'text-gray-400' : 'text-gray-500')); 
                symbol = diff > 0 ? <TrendUpIcon /> : (diff < 0 ? <TrendDownIcon /> : <span className="w-5 h-5 text-center">-</span>);
            }


            const changeText = percentageChange === 'N/A' 
                ? 'New Data' 
                : <span className="flex items-center justify-end">
                    <span className="mr-1.5">{symbol}</span>
                    {/* CONVERTED diff */}
                    {formatCurrency(Math.abs(diff), displayCurrencyCode, exchangeRates)} ({Math.abs(percentageChange)}%)
                  </span>;

            return (
                <div className={`flex justify-between items-center py-3 border-b ${border}`}>
                    <span className={`font-semibold ${color}`}>{title}</span>
                    {/* CONVERTED values */}
                    <div className={`flex-1 text-center font-medium ${textColor} hidden md:block`}>{formatCurrency(valueA_USD, displayCurrencyCode, exchangeRates)}</div>
                    <div className={`flex-1 text-center font-medium ${textColor} hidden md:block`}>{formatCurrency(valueB_USD, displayCurrencyCode, exchangeRates)}</div>
                    <div className={`flex-1 text-right md:text-center font-bold ${diffColor} flex items-center justify-center`}>
                        {changeText}
                    </div>
                </div>
            );
        };

        return (
            <div className={`w-full p-6 rounded-xl shadow-lg mt-8 ${cardBg}`}>
                <div className={`flex justify-between items-center mb-6 border-b ${border} pb-4`}>
                    <h2 className={`text-2xl font-bold ${headingColor}`}>Comparative Report</h2>
                    <button 
                        onClick={() => setCurrentView('Dashboard')}
                        className={`text-sm font-semibold text-indigo-600 hover:text-indigo-800 p-2 rounded-lg ${theme === 'dark' ? 'bg-gray-700' : 'bg-indigo-50'}`}
                    >
                        &larr; Back to Dashboard
                    </button>
                </div>

                {/* Report Period Selection */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                    {/* Period A */}
                    <div className={`p-4 border rounded-lg ${theme === 'dark' ? 'bg-gray-900 border-gray-700' : 'bg-gray-50 border-gray-200'}`}>
                        <h4 className={`font-semibold mb-2 ${headingColor}`}>Period A: {getPeriodLabel(reportMonthA, reportYearA)}</h4>
                        <div className="flex gap-2">
                            <select value={reportMonthA} onChange={(e) => setReportMonthA(e.target.value)} className={`p-2 border rounded-lg flex-1 ${inputBg}`}>
                                <option value="">All Months</option>
                                {Array.from({ length: 12 }, (_, i) => i + 1).map(month => (
                                    <option key={month} value={month.toString()}>{new Date(0, month - 1).toLocaleString('default', { month: 'short' })}</option>
                                ))}
                            </select>
                            <select value={reportYearA} onChange={(e) => setReportYearA(e.target.value)} className={`p-2 border rounded-lg flex-1 ${inputBg}`}>
                                <option value="">All Years</option>
                                {years.map(year => <option key={year} value={year}>{year}</option>)}
                            </select>
                        </div>
                    </div>
                    {/* Period B */}
                    <div className={`p-4 border rounded-lg ${theme === 'dark' ? 'bg-gray-900 border-gray-700' : 'bg-gray-50 border-gray-200'}`}>
                        <h4 className={`font-semibold mb-2 ${headingColor}`}>Period B: {getPeriodLabel(reportMonthB, reportYearB)}</h4>
                        <div className="flex gap-2">
                            <select value={reportMonthB} onChange={(e) => setReportMonthB(e.target.value)} className={`p-2 border rounded-lg flex-1 ${inputBg}`}>
                                <option value="">All Months</option>
                                {Array.from({ length: 12 }, (_, i) => i + 1).map(month => (
                                    <option key={month} value={month.toString()}>{new Date(0, month - 1).toLocaleString('default', { month: 'short' })}</option>
                                ))}
                            </select>
                            <select value={reportYearB} onChange={(e) => setReportYearB(e.target.value)} className={`p-2 border rounded-lg flex-1 ${inputBg}`}>
                                <option value="">All Years</option>
                                {years.map(year => <option key={year} value={year}>{year}</option>)}
                            </select>
                        </div>
                    </div>
                </div>

                {/* Comparison Table Header */}
                <div className={`flex justify-between items-center p-3 font-bold rounded-t-lg text-sm border-b ${tableHeaderBg} ${textColor} ${border}`}>
                    <span className="w-1/4">Metric</span>
                    <span className="flex-1 text-center hidden md:block">Period A ({getPeriodLabel(reportMonthA, reportYearA)})</span>
                    <span className="flex-1 text-center hidden md:block">Period B ({getPeriodLabel(reportMonthB, reportYearB)})</span>
                    <span className="w-1.5 text-right md:text-center">Change (A vs B)</span>
                </div>

                {/* Comparison Data Rows */}
                <div className={`rounded-b-lg p-2 ${theme === 'dark' ? 'bg-gray-800' : 'bg-white'}`}>
                    <ComparisonRow 
                        title="Total Income" 
                        valueA_USD={dataA.summary.income} 
                        valueB_USD={dataB.summary.income} 
                        color="text-green-600"
                    />
                    <ComparisonRow 
                        title="Total Expenses" 
                        valueA_USD={dataA.summary.expense} 
                        valueB_USD={dataB.summary.expense} 
                        color="text-red-600"
                    />
                    <ComparisonRow 
                        title="Net Balance" 
                        valueA_USD={dataA.summary.balance} 
                        valueB_USD={dataB.summary.balance} 
                        color={theme === 'dark' ? 'text-indigo-400' : 'text-indigo-600'}
                    />
                </div>
            </div>
        );
    };

    const DashboardView = () => (
        <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                <SummaryCard 
                    title="Current Balance" 
                    baseValue={dashboardData.summary.balance} // Pass base USD value
                    bgColor={dashboardData.summary.balance >= 0 ? (theme === 'dark' ? 'bg-indigo-700' : 'bg-indigo-600') : (theme === 'dark' ? 'bg-red-800' : 'bg-red-700')}
                />
                <SummaryCard title="Total Income" baseValue={dashboardData.summary.income} bgColor={theme === 'dark' ? 'bg-green-700' : 'bg-green-500'} />
                <SummaryCard title="Total Expenses" baseValue={dashboardData.summary.expense} bgColor={theme ==='dark' ? 'bg-red-700' : 'bg-red-500'} />
                
                <div className="md:col-span-3">
                    <GoalCard summary={dashboardData.summary} />
                </div>
            </div>

            <div className="flex flex-wrap gap-3 justify-start items-center mb-6">
                <button
                    onClick={() => setShowTransactionModal(true)}
                    className="bg-indigo-600 text-white font-bold py-2 px-4 rounded-lg shadow-md hover:bg-indigo-700 transition duration-150 flex items-center justify-center w-full sm:w-auto"
                    disabled={!userId}
                >
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
                    Add Transaction
                </button>
            </div>

            <FilterAndCurrencyCard />
            
            <ExpenseChart expenseCategoryData={dashboardData.expenseCategoryData} />

            <TransactionList filteredTransactions={dashboardData.filteredTransactions} />
        </>
    );

    return (
        <div className={`min-h-screen p-4 sm:p-8 ${theme === 'dark' ? 'bg-gray-900' : 'bg-gray-100'}`}>
            {/* Modals */}
            {showGoalModal && <GoalModal 
                goalUSD={monthlyGoalUSD} 
                onSave={handleSaveGoal} 
                onClose={() => setShowGoalModal(false)} 
            />}
            <AddTransactionModal />
            <ConfigModal 
                categories={userCategories} 
                recurringTemplates={recurringTemplates} 
                onClose={() => setShowConfigModal(false)}
                // Pass all state and helpers needed by sub-components
                theme={theme}
                setTheme={setTheme}
                db={db}
                userId={userId}
                appId={appId}
                formatCurrency={formatCurrency}
                displayCurrencyCode={displayCurrencyCode}
                exchangeRates={exchangeRates}
                setShowConfirmResetModal={setShowConfirmResetModal}
                setCurrentView={setCurrentView}
                setShowGoalModal={setShowGoalModal}
            />
            <ConfirmResetModal />

            {/* Main Container */}
            <div className={`max-w-4xl mx-auto shadow-2xl rounded-xl p-6 sm:p-8 ${theme === 'dark' ? 'bg-gray-800 border border-gray-700' : 'bg-white'}`}>

                <div className="flex justify-between items-start mb-6">
                    <h1 className={`text-3xl font-bold ${theme === 'dark' ? 'text-white' : 'text-gray-800'}`}>Budget Flow</h1>
                    
                    <button
                        onClick={() => setShowConfigModal(true)}
                        className={`p-2 rounded-full ${theme === 'dark' ? 'text-gray-400 hover:bg-gray-700 hover:text-gray-200' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'} transition`}
                        disabled={!userId}
                        title="Open Settings and Configuration"
                    >
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.82 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.82 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.82-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.82-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                    </button>
                </div>

                {isLoading ? (
                    <LoadingSpinner />
                ) : (
                    currentView === 'Dashboard' ? <DashboardView /> : <ReportView />
                )}
            </div>

            {/* Footer with User ID */}
            <footer className="max-w-4xl mx-auto mt-4 p-4 text-center text-xs text-gray-500">
                <span className={`${theme === 'dark' ? 'text-gray-400' : 'text-gray-600'} font-medium`}>Budget Flow</span> | Authenticated User ID: <span id="user-id-display" className="font-mono text-indigo-500 break-all">{userId || 'N/A'}</span>
            </footer>
        </div>
    );
}

export default App;


