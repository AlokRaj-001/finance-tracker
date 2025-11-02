import React, { useState } from "react";
import "./AuthPage.css"; // Make sure this CSS file exists in the same directory
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";

const AuthPage = ({ auth, onLoginSuccess }) => {
  // `isLoginMode` state tracks whether we are on the "Login" or "Sign Up" form.
  const [isLoginMode, setIsLoginMode] = useState(true);

  // Form data state for all inputs
  const [formData, setFormData] = useState({
    username: "", // Only for sign up
    email: "",
    password: "",
    confirmPassword: "", // Only for sign up
  });

  // State for any error messages
  const [error, setError] = useState("");
  // State to show loading spinner/disable button during API calls
  const [isLoading, setIsLoading] = useState(false);

  // Handler to toggle between Login and Sign Up
  const switchModeHandler = () => {
    setIsLoginMode((prevMode) => !prevMode);
    setFormData({ username: "", email: "", password: "", confirmPassword: "" }); // Clear inputs
    setError(""); // Clear errors
    setIsLoading(false); // Reset loading state
  };

  // Handler to update form data as user types
  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  // Handler for form submission
  const submitHandler = async (e) => {
    e.preventDefault();
    setError(""); // Clear previous errors
    setIsLoading(true); // Start loading

    const { username, email, password, confirmPassword } = formData;

    // --- SIGN UP LOGIC ---
    if (!isLoginMode) {
      // Basic Validation for Sign Up
      if (username.trim().length === 0) {
        setError("Username is required.");
        setIsLoading(false);
        return;
      }
      if (!email.includes("@")) {
        // Simple email check
        setError("Please enter a valid email address.");
        setIsLoading(false);
        return;
      }
      if (password.length < 6) {
        setError("Password must be at least 6 characters long.");
        setIsLoading(false);
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        setIsLoading(false);
        return;
      }

      console.log("Attempting Sign Up with:", username, email, password);
      // **TODO: Replace with your actual Sign Up API call**
      try {
        // 1. Create the user in Firebase (which also signs them in!)
        await createUserWithEmailAndPassword(auth, email, password);

        // 2. Clear the form
        setFormData({
          username: "",
          email: "",
          password: "",
          confirmPassword: "",
        });

        // 3. SIGNAL SUCCESS to App.js and redirect to the dashboard
        onLoginSuccess(); // <-- NEW: Go straight to dashboard!

        
      } catch (err) {
        console.error("Sign Up failed:", err.message);
        // Show user-friendly error message
        setError(
          err.message.includes("email-already-in-use")
            ? "Email address is already in use."
            : "Failed to sign up. Please try again."
        );
      }

      // --- LOGIN LOGIC ---
    } else {
      // Basic Validation for Login
      if (!email.includes("@")) {
        // Simple email check
        setError("Please enter a valid email address.");
        setIsLoading(false);
        return;
      }
      if (password.length === 0) {
        setError("Password cannot be empty.");
        setIsLoading(false);
        return;
      }

      console.log("Attempting Login with:", email, password);
      // **TODO: Replace with your actual Login API call**
      try {
        // 1. Sign in the user in Firebase
        await signInWithEmailAndPassword(auth, email, password);

        // 2. Signal the parent component (App.js) to switch to the dashboard
        onLoginSuccess();

        // 3. Optional: Clear inputs after successful login
        setFormData({
          username: "",
          email: "",
          password: "",
          confirmPassword: "",
        });
      } catch (err) {
        console.error("Login failed:", err.message);
        // Show user-friendly error message
        setError("Login failed. Please check your email and password.");
      }
    }

    setIsLoading(false); // Stop loading regardless of success/failure
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-card">
        <h2>{isLoginMode ? "Sign In" : "Create Account"}</h2>

        <form onSubmit={submitHandler}>
          {/* Show Username field only in "Sign Up" mode */}
          {!isLoginMode && (
            <div className="form-group">
              <label htmlFor="username">Username</label>
              <input
                type="text"
                id="username"
                name="username"
                value={formData.username}
                onChange={handleChange}
                placeholder="Choose a username"
                required={!isLoginMode} // Required only when signing up
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="your@example.com"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Must be at least 6 characters"
              minLength="6"
              required
            />
          </div>

          {/* Show Confirm Password field only in "Sign Up" mode */}
          {!isLoginMode && (
            <div className="form-group">
              <label htmlFor="confirmPassword">Confirm Password</label>
              <input
                type="password"
                id="confirmPassword"
                name="confirmPassword"
                value={formData.confirmPassword}
                onChange={handleChange}
                placeholder="Re-enter your password"
                required={!isLoginMode} // Required only when signing up
              />
            </div>
          )}

          {/* Display any errors */}
          {error && <p className="auth-error">{error}</p>}

          <button type="submit" className="btn-submit" disabled={isLoading}>
            {isLoading ? "Loading..." : isLoginMode ? "Sign In" : "Sign Up"}
          </button>
        </form>

        <button
          onClick={switchModeHandler}
          className="btn-toggle"
          disabled={isLoading}
        >
          {isLoginMode
            ? "Don't have an account? Create one."
            : "Already have an account? Sign In."}
        </button>
      </div>
    </div>
  );
};

export default AuthPage;
