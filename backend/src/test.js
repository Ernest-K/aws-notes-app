import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { Sequelize, DataTypes } from "sequelize";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  ConfirmSignUpCommand,
  GetUserCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CloudWatchClient, PutMetricDataCommand, PutDashboardCommand } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient, CreateLogGroupCommand, CreateLogStreamCommand, PutLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use("/uploads", express.static("uploads"));

// Konfiguracja klientów AWS
const region = process.env.AWS_REGION;
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
};

// CloudWatch klienty
const cloudWatchClient = new CloudWatchClient({ region, credentials });
const cloudWatchLogsClient = new CloudWatchLogsClient({ region, credentials });

// Konfiguracja logów CloudWatch
const logGroupName = `/app/${process.env.NODE_ENV || "development"}/api-logs`;
const logStreamName = `app-logs-${new Date().toISOString().slice(0, 10)}`;

// Inicjalizacja grupy i strumienia logów
const initCloudWatchLogs = async () => {
  try {
    // Utwórz grupę logów (ignoruj błąd jeśli już istnieje)
    try {
      await cloudWatchLogsClient.send(
        new CreateLogGroupCommand({
          logGroupName,
        })
      );
      console.log(`Log group created: ${logGroupName}`);
    } catch (error) {
      if (error.name !== "ResourceAlreadyExistsException") {
        throw error;
      }
    }

    // Utwórz strumień logów (ignoruj błąd jeśli już istnieje)
    try {
      await cloudWatchLogsClient.send(
        new CreateLogStreamCommand({
          logGroupName,
          logStreamName,
        })
      );
      console.log(`Log stream created: ${logStreamName}`);
    } catch (error) {
      if (error.name !== "ResourceAlreadyExistsException") {
        throw error;
      }
    }
  } catch (error) {
    console.error("Error initializing CloudWatch Logs:", error);
  }
};

// Inicjalizuj logi przy starcie
initCloudWatchLogs();

// Sekwencyjny token dla śledzenia wpisów w log stream
let sequenceToken = null;

// Funkcja do wysyłania logów do CloudWatch
const logToCloudWatch = async (message, level = "INFO") => {
  try {
    const timestamp = new Date().getTime();

    const params = {
      logGroupName,
      logStreamName,
      logEvents: [
        {
          timestamp,
          message: `[${level}] ${message}`,
        },
      ],
    };

    // Dodaj sekwencyjny token jeśli jest dostępny
    if (sequenceToken) {
      params.sequenceToken = sequenceToken;
    }

    const command = new PutLogEventsCommand(params);
    const response = await cloudWatchLogsClient.send(command);

    // Aktualizuj token do następnego wpisu
    sequenceToken = response.nextSequenceToken;
  } catch (error) {
    // Jeśli token wygasł, pobierz nowy token z błędu
    if (error.name === "InvalidSequenceTokenException") {
      sequenceToken = error.expectedSequenceToken;
      // Spróbuj ponownie z nowym tokenem
      return logToCloudWatch(message, level);
    }
    console.error("Error sending logs to CloudWatch:", error);
  }
};

// Middleware do rejestrowania żądań
app.use(async (req, res, next) => {
  const startTime = Date.now();

  // Zapisz oryginalną funkcję end
  const originalEnd = res.end;

  // Nadpisz funkcję end, aby zalogować odpowiedź
  res.end = function (...args) {
    const responseTime = Date.now() - startTime;
    const message = `${req.method} ${req.originalUrl} - Status: ${res.statusCode} - ${responseTime}ms`;

    // Wysyłaj do CloudWatch
    logToCloudWatch(message);

    // Wysyłaj metryki do CloudWatch
    sendMetricToCloudWatch("ResponseTime", responseTime, "Milliseconds", {
      Path: req.path,
      Method: req.method,
      StatusCode: res.statusCode.toString(),
    });

    // Wywołaj oryginalną funkcję end
    return originalEnd.apply(this, args);
  };

  next();
});

// Funkcja do wysyłania metryk do CloudWatch
const sendMetricToCloudWatch = async (metricName, value, unit, dimensions = {}) => {
  try {
    const dimensionsArray = Object.entries(dimensions).map(([name, value]) => ({
      Name: name,
      Value: value,
    }));

    const params = {
      MetricData: [
        {
          MetricName: metricName,
          Dimensions: dimensionsArray,
          Unit: unit,
          Value: value,
          Timestamp: new Date(),
        },
      ],
      Namespace: "NotesApplication",
    };

    await cloudWatchClient.send(new PutMetricDataCommand(params));
  } catch (error) {
    console.error("Error sending metric to CloudWatch:", error);
  }
};

// Tworzenie dashboardu w CloudWatch
const createCloudWatchDashboard = async () => {
  try {
    // JSON definiujący wygląd dashboardu
    const dashboardBody = {
      widgets: [
        {
          type: "metric",
          x: 0,
          y: 0,
          width: 12,
          height: 6,
          properties: {
            metrics: [
              ["NotesApplication", "ResponseTime", "Method", "GET", "Path", "/notes"],
              ["NotesApplication", "ResponseTime", "Method", "POST", "Path", "/notes"],
            ],
            view: "timeSeries",
            stacked: false,
            region: region,
            title: "API Response Times",
            period: 300,
            stat: "Average",
          },
        },
        {
          type: "metric",
          x: 0,
          y: 6,
          width: 12,
          height: 6,
          properties: {
            metrics: [
              ["NotesApplication", "ResponseTime", "StatusCode", "200"],
              ["NotesApplication", "ResponseTime", "StatusCode", "400"],
              ["NotesApplication", "ResponseTime", "StatusCode", "401"],
              ["NotesApplication", "ResponseTime", "StatusCode", "404"],
              ["NotesApplication", "ResponseTime", "StatusCode", "500"],
            ],
            view: "timeSeries",
            stacked: false,
            region: region,
            title: "Response Times by Status Code",
            period: 300,
            stat: "Average",
          },
        },
      ],
    };

    const params = {
      DashboardName: "NotesApplication-Dashboard",
      DashboardBody: JSON.stringify(dashboardBody),
    };

    await cloudWatchClient.send(new PutDashboardCommand(params));
    console.log("CloudWatch dashboard created successfully");
  } catch (error) {
    console.error("Error creating CloudWatch dashboard:", error);
  }
};

// Inicjalizuj dashboard przy starcie serwera
createCloudWatchDashboard();

// Konfiguracja bazy danych
const sequelize = new Sequelize(process.env.DB_URL, {
  dialect: "postgres",
  logging: false,
});

// Model notatek
const Note = sequelize.define(
  "Note",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    timestamps: true,
  }
);

// Model użytkowników (do powiązania z Cognito)
const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    cognitoId: {
      type: DataTypes.STRING,
      unique: true,
    },
    email: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    timestamps: true,
  }
);

// Relacje
Note.belongsTo(User, { foreignKey: "userId", as: "author" });
User.hasMany(Note, { foreignKey: "userId", as: "notes" });

sequelize.sync();

// Inicjalizacja klienta S3 z AWS SDK v3
const s3Client = new S3Client({
  region,
  credentials,
});

// Inicjalizacja klienta Cognito
const cognitoClient = new CognitoIdentityProviderClient({
  region,
  credentials,
});

const storage = multer.memoryStorage();
const upload = multer({ storage });

// Middleware do obsługi błędów - logowanie do CloudWatch
app.use((err, req, res, next) => {
  const errorMessage = `Error: ${err.message} - Stack: ${err.stack}`;
  logToCloudWatch(errorMessage, "ERROR");

  res.status(500).json({ message: "Wystąpił błąd serwera", error: err.message });
});

// Middleware do weryfikacji tokenu
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    await logToCloudWatch(`Authentication failed: No token provided`, "WARN");
    return res.status(401).json({ message: "Brak tokenu uwierzytelniającego" });
  }

  try {
    // Weryfikacja tokenu w Cognito
    const command = new GetUserCommand({
      AccessToken: token,
    });

    const userData = await cognitoClient.send(command);

    // Wyciągnięcie informacji o użytkowniku
    const userAttributes = {};
    userData.UserAttributes.forEach((attr) => {
      userAttributes[attr.Name] = attr.Value;
    });

    // Sprawdzenie, czy użytkownik istnieje w bazie danych
    let user = await User.findOne({ where: { email: userAttributes["email"] } });

    if (!user) {
      // Jeśli nie istnieje, utworzenie nowego rekordu
      user = await User.create({
        email: userAttributes["email"],
        cognitoId: userData.Username,
        firstName: userAttributes["given_name"] || "",
        lastName: userAttributes["family_name"] || "",
      });

      await logToCloudWatch(`New user record created for: ${userAttributes["email"]}`, "INFO");
    }

    // Dodanie informacji o użytkowniku do obiektu request
    req.user = {
      id: user.id,
      email: user.email,
      cognitoId: user.cognitoId,
    };

    await logToCloudWatch(`User authenticated: ${user.email}`, "INFO");
    next();
  } catch (error) {
    await logToCloudWatch(`Authentication failed: ${error.message}`, "ERROR");
    return res.status(403).json({ message: "Token nieprawidłowy lub wygasł", error: error.message });
  }
};

// Upload plików do S3 z AWS SDK v3
const uploadToS3 = async (file, userId) => {
  const key = `${userId}/${uuidv4()}${path.extname(file.originalname)}`;

  const params = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: "public-read",
  };

  const command = new PutObjectCommand(params);
  await s3Client.send(command);

  // Log upload event
  await logToCloudWatch(`File uploaded to S3: ${key}`, "INFO");

  // Send S3 upload metric
  await sendMetricToCloudWatch("S3Upload", 1, "Count", {
    UserId: userId,
    FileType: path.extname(file.originalname).substring(1) || "unknown",
  });

  return {
    Location: `https://${process.env.AWS_BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`,
  };
};

// === Reszta endpointów pozostaje taka sama jak w poprzednim kodzie ===
// Endpointy do uwierzytelniania

// Rejestracja użytkownika
app.post("/auth/register", async (req, res) => {
  const { email, password, firstName, lastName } = req.body;

  if (!email || !password) {
    await logToCloudWatch(`Registration failed: Missing email or password`, "WARN");
    return res.status(400).json({ message: "Email i hasło są wymagane" });
  }

  try {
    const command = new SignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "given_name", Value: firstName || "" },
        { Name: "family_name", Value: lastName || "" },
      ],
    });

    const response = await cognitoClient.send(command);

    // Zapisanie podstawowych informacji o użytkowniku w bazie danych
    await User.create({
      email,
      cognitoId: response.UserSub,
      firstName: firstName || null,
      lastName: lastName || null,
    });

    await logToCloudWatch(`New user registered: ${email}`, "INFO");
    await sendMetricToCloudWatch("UserRegistration", 1, "Count");

    res.status(201).json({
      message: "Użytkownik zarejestrowany. Sprawdź email, aby potwierdzić konto.",
      userId: response.UserSub,
    });
  } catch (error) {
    await logToCloudWatch(`Registration error: ${error.message}`, "ERROR");
    res.status(400).json({ message: "Błąd podczas rejestracji", error: error.message });
  }
});

// Potwierdzenie rejestracji
app.post("/auth/confirm", async (req, res) => {
  const { email, confirmationCode } = req.body;

  try {
    const command = new ConfirmSignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: confirmationCode,
    });

    await cognitoClient.send(command);
    await logToCloudWatch(`User confirmed registration: ${email}`, "INFO");
    res.json({ message: "Konto zostało potwierdzone. Możesz się teraz zalogować." });
  } catch (error) {
    await logToCloudWatch(`Confirmation error: ${error.message}`, "ERROR");
    res.status(400).json({ message: "Błąd podczas potwierdzania konta", error: error.message });
  }
});

// Logowanie użytkownika
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const command = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: process.env.COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    });

    const response = await cognitoClient.send(command);

    // Znalezienie lub utworzenie użytkownika w lokalnej bazie danych
    const getUserCommand = new GetUserCommand({
      AccessToken: response.AuthenticationResult.AccessToken,
    });

    const userData = await cognitoClient.send(getUserCommand);

    const userAttributes = {};
    userData.UserAttributes.forEach((attr) => {
      userAttributes[attr.Name] = attr.Value;
    });

    // Sprawdzenie czy użytkownik istnieje w bazie
    let user = await User.findOne({ where: { email: userAttributes["email"] } });

    if (!user) {
      user = await User.create({
        email: userAttributes["email"],
        cognitoId: userData.Username,
        firstName: userAttributes["given_name"] || null,
        lastName: userAttributes["family_name"] || null,
      });
    }

    await logToCloudWatch(`User logged in: ${email}`, "INFO");
    await sendMetricToCloudWatch("UserLogin", 1, "Count");

    res.json({
      message: "Zalogowano pomyślnie",
      tokens: {
        idToken: response.AuthenticationResult.IdToken,
        accessToken: response.AuthenticationResult.AccessToken,
        refreshToken: response.AuthenticationResult.RefreshToken,
        expiresIn: response.AuthenticationResult.ExpiresIn,
      },
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } catch (error) {
    await logToCloudWatch(`Login error: ${error.message}`, "ERROR");
    res.status(401).json({ message: "Nieprawidłowe dane logowania", error: error.message });
  }
});

// === Pozostałe endpointy do uwierzytelniania i notatek ===

// Upload plików
app.post("/upload", authenticateToken, upload.single("file"), async (req, res) => {
  if (!req.file) {
    await logToCloudWatch(`File upload failed: No file provided`, "WARN");
    return res.status(400).json({ message: "Plik nie został przesłany" });
  }

  try {
    const data = await uploadToS3(req.file, req.user.id);
    res.json({ fileUrl: data.Location });
  } catch (error) {
    await logToCloudWatch(`File upload error: ${error.message}`, "ERROR");
    res.status(500).json({ message: "Wystąpił błąd podczas przesyłania pliku", error });
  }
});

// Endpoint do sprawdzania statystyk aplikacji (tylko dla administratorów)
app.get("/admin/stats", authenticateToken, async (req, res) => {
  // Tutaj można dodać sprawdzanie roli użytkownika

  try {
    const totalUsers = await User.count();
    const totalNotes = await Note.count();
    const notesPerUser = await Note.count({
      attributes: ["userId"],
      group: ["userId"],
      raw: true,
    });

    // Wysyłanie metryk dotyczących ilości danych
    await sendMetricToCloudWatch("TotalUsers", totalUsers, "Count");
    await sendMetricToCloudWatch("TotalNotes", totalNotes, "Count");

    res.json({
      totalUsers,
      totalNotes,
      averageNotesPerUser: totalUsers > 0 ? totalNotes / totalUsers : 0,
      notesDistribution: notesPerUser,
    });
  } catch (error) {
    await logToCloudWatch(`Stats error: ${error.message}`, "ERROR");
    res.status(500).json({ message: "Wystąpił błąd podczas pobierania statystyk", error });
  }
});

app.listen(port, () => {
  logToCloudWatch(`Server started on port ${port}`);
  console.log(`Server running on port ${port}`);
});
